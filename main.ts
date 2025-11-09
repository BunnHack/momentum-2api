// 配置变量
const API_BASE_URL = "https://movementlabs.ai";
const DEFAULT_AUTH_KEYS = ["sk-default", "sk-false"];
const DEFAULT_SESSIONS = ["session1", "session2"];
const AUTH_SESSIONS = Deno.env.get("AUTH_SESSIONS")?.split(",") || DEFAULT_SESSIONS;

// 浏览器 User-Agent 列表
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
];

// 模型列表
const MODELS = [
  "momentum",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
];

// 随机选择 User-Agent
function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 随机选择 Session
function getRandomSession(sessions: string[]): string {
  return sessions[Math.floor(Math.random() * sessions.length)];
}

// 生成随机 UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// 解析 API Key 并返回对应的 sessions
function parseAuthAndGetSessions(req: Request): string[] | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const token = authHeader.replace(/^Bearer\s+/i, "");
  
  // 如果是默认的 auth key,使用内置的 sessions
  if (DEFAULT_AUTH_KEYS.includes(token)) {
    return AUTH_SESSIONS;
  }
  
  // 否则,将 token 作为 sessions(支持逗号分隔的多个 session)
  const sessions = token.split(",").map(s => s.trim()).filter(s => s.length > 0);
  return sessions.length > 0 ? sessions : null;
}

// CORS 响应头
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// 处理 /v1/models 请求
function handleModelsRequest(): Response {
  const modelsData = {
    object: "list",
    data: MODELS.map((modelId) => ({
      id: modelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "movementlabs",
    })),
  };

  return new Response(JSON.stringify(modelsData), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(),
    },
  });
}

// 转换消息格式
function convertMessages(messages: any[]): any[] {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
  }));
}

// 计算 user 消息数量
function countUserMessages(messages: any[]): number {
  return messages.filter((msg) => msg.role !== "assistant").length;
}

// 解析目标 API 响应的流式数据
function parseStreamChunk(chunk: string): string | null {
  if (!chunk.startsWith('0:"')) return null;
  
  try {
    // 提取 0:"content" 中的 content
    const match = chunk.match(/^0:"(.*)"/);
    if (match && match[1]) {
      return match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  } catch (e) {
    console.error("Parse chunk error:", e);
  }
  return null;
}

// 创建 OpenAI 格式的流式响应块
function createStreamChunk(
  id: string,
  model: string,
  content: string,
  finishReason: string | null = null
): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: finishReason
          ? { content: "", reasoning_content: null }
          : { content, reasoning_content: null },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// 处理流式响应
async function handleStreamResponse(
  targetResponse: Response,
  model: string
): Promise<Response> {
  const reader = targetResponse.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = generateUUID();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 发送首个块（包含 role）
        const firstChunk = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                reasoning_content: null,
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));

        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;

            const content = parseStreamChunk(line);
            if (content !== null) {
              const chunk = createStreamChunk(id, model, content);
              controller.enqueue(encoder.encode(chunk));
            }
          }
        }

        // 处理剩余的 buffer
        if (buffer.trim()) {
          const content = parseStreamChunk(buffer);
          if (content !== null) {
            const chunk = createStreamChunk(id, model, content);
            controller.enqueue(encoder.encode(chunk));
          }
        }

        // 发送结束块
        const finishChunk = createStreamChunk(id, model, "", "stop");
        controller.enqueue(encoder.encode(finishChunk));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

        controller.close();
      } catch (error) {
        console.error("Stream error:", error);
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...getCorsHeaders(),
    },
  });
}

// 处理非流式响应
async function handleNonStreamResponse(
  targetResponse: Response,
  model: string
): Promise<Response> {
  const reader = targetResponse.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      const content = parseStreamChunk(line);
      if (content !== null) {
        fullContent += content;
      }
    }
  }

  // 处理剩余的 buffer
  if (buffer.trim()) {
    const content = parseStreamChunk(buffer);
    if (content !== null) {
      fullContent += content;
    }
  }

  const response = {
    id: generateUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullContent,
          reasoning_content: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(),
    },
  });
}

// 处理聊天完成请求
async function handleChatCompletion(req: Request, sessions: string[]): Promise<Response> {
  try {
    const body = await req.json();
    const { messages, stream = false, model = "momentum" } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "Invalid messages format" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders() },
        }
      );
    }

    // 转换消息格式
    const convertedMessages = convertMessages(messages);
    const userMessageCount = countUserMessages(messages);

    // 随机选择一个 session
    const selectedSession = getRandomSession(sessions);

    // 构造目标 API 请求
    const targetUrl = `${API_BASE_URL}/api/chat`;
    const targetBody = {
      messages: convertedMessages,
    };

    const targetResponse = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-message-count": userMessageCount.toString(),
        "User-Agent": getRandomUserAgent(),
        "Referer": `${API_BASE_URL}/`,
        "Cookie": `__session=${selectedSession}`,
      },
      body: JSON.stringify(targetBody),
    });

    if (!targetResponse.ok) {
      return new Response(
        JSON.stringify({ 
          error: "Target API request failed",
          status: targetResponse.status,
          statusText: targetResponse.statusText
        }),
        {
          status: targetResponse.status,
          headers: { "Content-Type": "application/json", ...getCorsHeaders() },
        }
      );
    }

    // 根据 stream 参数返回相应格式
    if (stream) {
      return await handleStreamResponse(targetResponse, model);
    } else {
      return await handleNonStreamResponse(targetResponse, model);
    }
  } catch (error) {
    console.error("Chat completion error:", error);
    return new Response(
      JSON.stringify({ 
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error)
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders() },
      }
    );
  }
}

// 主处理函数
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(),
    });
  }

  // 健康检查
  if (url.pathname === "/") {
    return new Response(
      JSON.stringify({
        status: "ok",
        message: "API is healthy",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...getCorsHeaders() },
      }
    );
  }

  // 解析 API Key 并获取 sessions（除了首页）
  const sessions = parseAuthAndGetSessions(req);
  if (!sessions) {
    return new Response(
      JSON.stringify({ 
        error: "Unauthorized",
        message: "Invalid or missing Authorization header"
      }), 
      {
        status: 401,
        headers: { "Content-Type": "application/json", ...getCorsHeaders() },
      }
    );
  }

  // 路由处理
  if (url.pathname === "/v1/models" && req.method === "GET") {
    return handleModelsRequest();
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    return await handleChatCompletion(req, sessions);
  }

  // 未找到路由
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...getCorsHeaders() },
  });
}

// 启动服务
Deno.serve(handler);

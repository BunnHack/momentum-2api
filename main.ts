import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

// --- 配置 ---

// 上游 Movement Labs API 地址
const UPSTREAM_URL = "https://www.movementlabs.ai/api/chat";

// 我们定义的模型 ID
const MODEL_ID = "movement";

// --- CORS 头 ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};


// --- 核心处理器 ---

/**
 * 主请求处理器，根据路径路由到不同函数
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 路由
  switch (url.pathname) {
    case "/v1/models":
      return handleModelsRequest();
    case "/v1/chat/completions":
      return await handleChatCompletionsRequest(req);
    default:
      return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
}

/**
 * 处理 /v1/models 请求
 * 返回一个静态的模型列表
 */
function handleModelsRequest(): Response {
  const responseBody = {
    object: "list",
    data: [
      {
        id: MODEL_ID,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "movement-labs",
      },
    ],
  };
  return new Response(JSON.stringify(responseBody), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * 处理 /v1/chat/completions 请求
 * 将请求转发到上游 API，并转换响应格式
 */
async function handleChatCompletionsRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const requestBody = await req.json();
    const { messages, stream = false } = requestBody;

    if (!messages || !Array.isArray(messages)) {
      return new Response('Missing or invalid "messages" in request body', { status: 400, headers: corsHeaders });
    }

    // 构造向上游 API 的请求
    const upstreamPayload = { messages };

    // ** [关键更新] **
    // 添加伪装头，模拟从其官网前端发出的请求，以绕过 403 Forbidden 保护
    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'x-message-count': '0', // 根据抓包示例设置
      'Referer': 'https://www.movementlabs.ai/',
      'Origin': 'https://www.movementlabs.ai',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    };

    const upstreamResponse = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamPayload),
    });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      console.error(`Upstream API Error: ${upstreamResponse.status} ${errorBody}`);
      // 将上游的错误信息更友好地返回给客户端
      const errorJson = {
        error: {
            message: `Upstream API error: ${errorBody}`,
            type: "upstream_error",
            param: null,
            code: upstreamResponse.status
        }
      };
      return new Response(JSON.stringify(errorJson), { 
        status: upstreamResponse.status, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // 根据 stream 参数决定如何处理响应
    if (stream) {
      // 流式响应
      if (!upstreamResponse.body) {
         return new Response("Upstream response is empty", { status: 500, headers: corsHeaders });
      }
      const transformedStream = upstreamResponse.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(createOpenAIStreamTransformer());

      return new Response(transformedStream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } else {
      // 非流式响应
      return await handleNonStreamingResponse(upstreamResponse);
    }

  } catch (error) {
    console.error(`Error in chat completions handler: ${error}`);
    return new Response(JSON.stringify({ error: "Internal Server Error", message: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

/**
 * 处理非流式响应
 * @param upstreamResponse 从上游 API 收到的响应
 */
async function handleNonStreamingResponse(upstreamResponse: Response): Promise<Response> {
  const upstreamBody = await upstreamResponse.text();
  const lines = upstreamBody.split('\n');
  let fullContent = '';

  for (const line of lines) {
    if (line.startsWith('0:')) {
      try {
        const content = JSON.parse(line.substring(2));
        if (typeof content === 'string') {
          fullContent += content;
        }
      } catch (error) {
        console.warn('Ignoring malformed non-stream line:', line);
      }
    }
  }

  const completionResponse = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { // 因为上游不提供 token 数量，这里使用虚拟值
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(completionResponse), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * 创建一个转换流，将上游的 Vercel AI SDK 格式转换为 OpenAI SSE 格式
 */
function createOpenAIStreamTransformer(): TransformStream<string, Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');

      // 保留最后一行不完整的在缓冲区中
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('0:')) continue;

        try {
          // 内容是 JSON 编码的字符串，例如 0:"Hello"
          const content = JSON.parse(line.substring(2));
          if (typeof content !== 'string') continue;

          // 构造 OpenAI SSE chunk
          const chatCompletionChunk = {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [{
              index: 0,
              delta: { content: content },
              finish_reason: null,
            }],
          };

          const sse = `data: ${JSON.stringify(chatCompletionChunk)}\n\n`;
          controller.enqueue(encoder.encode(sse));

        } catch (error) {
          console.warn('Ignoring malformed stream line:', line);
        }
      }
    },
    flush(controller) {
      // 流结束时发送 [DONE] 消息
      const doneSse = 'data: [DONE]\n\n';
      controller.enqueue(encoder.encode(doneSse));
    },
  });
}

// --- 启动服务器 ---
console.log("Server starting on port 8000...");
serve(handler, { port: 8000 });

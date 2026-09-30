import { Channel, invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ContentPart {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  image_url?: { url: string };
  /** data URI（data:audio/mp4;base64,...），模型需支持音频输入 */
  input_audio?: { data: string };
}

interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

/** OpenAI 兼容 /chat/completions SSE 流式调用。
 *  打包后 WebView 源是 tauri:// 自定义协议，带 Authorization 的跨域 fetch 会被
 *  WebKit 拦截（TypeError: Load failed），因此请求走 Rust 侧（llm_chat_stream），
 *  SSE 分片经 Channel 推回。abort 只停止前端消费，Rust 侧连接随流结束自行关闭 */
export async function* streamChat(
  opts: StreamOptions
): AsyncGenerator<string, void, unknown> {
  const queue: string[] = [];
  let finished = false;
  let failed: unknown = null;
  let wake: (() => void) | null = null;

  const onChunk = new Channel<string>();
  onChunk.onmessage = (chunk) => {
    queue.push(chunk);
    wake?.();
  };

  invoke("llm_chat_stream", {
    endpoint: `${opts.baseUrl}/chat/completions`,
    apiKey: opts.apiKey,
    body: { model: opts.model, messages: opts.messages, stream: true },
    onChunk,
  })
    .catch((e) => {
      failed = e;
    })
    .finally(() => {
      finished = true;
      wake?.();
    });

  let buffer = "";
  while (true) {
    if (opts.signal?.aborted) return;
    if (queue.length > 0) {
      buffer += queue.shift()!;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string") yield delta;
        } catch {
          // 忽略不完整的 JSON 分片
        }
      }
      continue;
    }
    if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
    if (finished) return;
    await new Promise<void>((r) => {
      wake = r;
    });
    wake = null;
  }
}

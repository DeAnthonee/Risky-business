/** One chat message in the OpenAI chat-completions format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Anything that answers a chat: the local model in production, a scripted fake in tests. */
export interface ChatModel {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

export interface OpenAICompatOptions {
  /** Base URL up to /v1, e.g. http://127.0.0.1:11434/v1 (Ollama), :1234/v1 (LM Studio), :8080/v1 (llama.cpp). */
  baseUrl: string;
  model: string;
  /** Most local runtimes ignore it; hosted OpenAI-compatible APIs need it. */
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
}

/**
 * Chat client for any OpenAI-compatible /chat/completions endpoint. Every local runtime we might run on the
 * Mac mini (Ollama, LM Studio, llama.cpp server, MLX server) speaks this, so switching runtimes is config only.
 */
export class OpenAICompatModel implements ChatModel {
  readonly name: string;
  private baseUrl: string;

  constructor(private opts: OpenAICompatOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.name = opts.model;
  }

  async chat(messages: ChatMessage[], { maxTokens = 400, temperature }: { maxTokens?: number; temperature?: number } = {}): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.opts.model, messages, max_tokens: maxTokens, temperature: temperature ?? this.opts.temperature ?? 0.7, stream: false }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`model ${this.opts.model} at ${this.baseUrl}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`model ${this.opts.model}: no message in the reply`);
    return content;
  }
}

/**
 * The first JSON object in a model reply. Tolerates what local models wrap around it: reasoning blocks
 * (<think>...</think>), code fences and chatter before or after.
 */
export function extractJson(reply: string): Record<string, unknown> | null {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          /* try the next opening brace */
        }
        break;
      }
    }
  }
  return null;
}

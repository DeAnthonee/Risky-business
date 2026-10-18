export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Llm {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export interface ChatOptions {
  /** Rebuild dynamic prompts after waiting for a model slot. Null cancels without calling Ollama. */
  prepare?: () => ChatMessage[] | null;
  maxTokens?: number;
  temperature?: number;
  /** Ask the model for a JSON document (Ollama's format: "json"). */
  json?: boolean;
  /** Abort the request (e.g. the caller gave up waiting). */
  signal?: AbortSignal;
  /** Overrides the client's request timeout (long write-ups need more than a chat line). */
  timeoutMs?: number;
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /** Requests in flight at once; the rest queue. Default 2. */
  concurrency?: number;
  /** Context window (Ollama num_ctx). Default 20480. */
  numCtx?: number;
  /** How long Ollama keeps the model loaded between calls. Default "30m". */
  keepAlive?: string;
}

/** Counting semaphore: run() waits for a free slot, FIFO. */
export class Semaphore {
  private free: number;
  private queue: (() => void)[] = [];
  constructor(slots: number) {
    this.free = Math.max(1, slots);
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/** Remove <think>...</think> blocks (and an unclosed trailing one) that reasoning models may emit. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

/** Ollama's /api/chat, non-streaming. */
export class OllamaLlm implements Llm {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private gate: Semaphore;
  private numCtx: number;
  private keepAlive: string;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.model = opts.model ?? 'qwen3:14b';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.gate = new Semaphore(opts.concurrency ?? 1);
    this.numCtx = opts.numCtx ?? 20480;
    this.keepAlive = opts.keepAlive ?? '30m';
  }

  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    return this.gate.run(async () => {
      if (opts.signal?.aborted) throw new Error('Ollama request cancelled');
      const currentMessages = opts.prepare ? opts.prepare() : messages;
      if (!currentMessages) throw new Error('Ollama request cancelled: no current context');
      const ctrl = new AbortController();
      const cancel = () => ctrl.abort();
      opts.signal?.addEventListener('abort', cancel, { once: true });
      const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: this.model,
            messages: currentMessages,
            stream: false,
            think: false,
            keep_alive: this.keepAlive,
            ...(opts.json ? { format: 'json' } : {}),
            options: { num_predict: opts.maxTokens ?? 200, temperature: opts.temperature ?? 0.8, num_ctx: this.numCtx },
          }),
        });
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const body = (await res.json()) as { message?: { content?: string } };
        return stripThink(body.message?.content ?? '');
      } catch (e) {
        if (opts.signal?.aborted) throw new Error('Ollama request cancelled');
        if (ctrl.signal.aborted) throw new Error(`Ollama request timed out after ${timeoutMs} ms`);
        throw e;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', cancel);
      }
    });
  }
}

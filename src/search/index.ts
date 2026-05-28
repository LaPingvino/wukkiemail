// Main-thread handle to the search worker. Correlates request/response
// by an incrementing id so callers get plain promises. Degrades to a
// no-op (empty results) if Worker construction fails — search then just
// falls back to the in-memory item filter in App.

export interface MessageDoc {
  id: string;
  roomId: string;
  roomName: string;
  sender: string;
  body: string;
  ts: number;
}

export interface MessageHit extends MessageDoc {}

export class SearchIndex {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent) => {
        const { reqId, hits, error } = e.data ?? {};
        const p = this.pending.get(reqId);
        if (!p) return;
        this.pending.delete(reqId);
        if (error) p.reject(new Error(error));
        else p.resolve(hits ?? true);
      };
      this.worker.onerror = () => { /* leave pending to time out; non-fatal */ };
    } catch {
      this.worker = null;
    }
  }

  private call<T>(payload: Record<string, unknown>): Promise<T> {
    if (!this.worker) return Promise.resolve(([] as unknown) as T);
    const reqId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ ...payload, reqId });
    });
  }

  addMessages(docs: MessageDoc[]): Promise<void> {
    if (!docs.length) return Promise.resolve();
    return this.call<void>({ type: 'put', docs });
  }

  search(q: string, limit = 50): Promise<MessageHit[]> {
    return this.call<MessageHit[]>({ type: 'search', q, limit });
  }

  clear(): Promise<void> {
    return this.call<void>({ type: 'clear' });
  }
}

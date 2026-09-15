/**
 * In-Flight Request Coalescer
 * Deduplicates concurrent asynchronous operations for the exact same key.
 * If 10 callers request the same stock quote or crypto spot price simultaneously,
 * only 1 upstream network request is dispatched; all callers share the in-flight Promise.
 */
interface InFlightEntry<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: Set<{
    signal?: AbortSignal;
    onAbort?: () => void;
  }>;
}

export class RequestCoalescer {
  private inFlight = new Map<string, InFlightEntry<any>>();
  private _totalCoalescedCount = 0;

  async coalesce<T>(
    key: string,
    fetcher: (coalescedSignal?: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    let entry = this.inFlight.get(key) as InFlightEntry<T> | undefined;

    if (entry) {
      this._totalCoalescedCount++;
    } else {
      const controller = new AbortController();
      const subscribers = new Set<{ signal?: AbortSignal; onAbort?: () => void }>();

      const promise = (async () => {
        try {
          return await fetcher(controller.signal);
        } finally {
          this.inFlight.delete(key);
        }
      })();

      entry = { promise, controller, subscribers };
      this.inFlight.set(key, entry);
    }

    return new Promise<T>((resolve, reject) => {
      const sub = { signal: callerSignal, onAbort: undefined as (() => void) | undefined };

      const cleanup = () => {
        if (callerSignal && sub.onAbort) {
          callerSignal.removeEventListener('abort', sub.onAbort);
        }
        entry!.subscribers.delete(sub);
        if (entry!.subscribers.size === 0) {
          entry!.controller.abort(new DOMException('All coalesced callers aborted', 'AbortError'));
          this.inFlight.delete(key);
        }
      };

      if (callerSignal) {
        sub.onAbort = () => {
          cleanup();
          reject(callerSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        };
        callerSignal.addEventListener('abort', sub.onAbort, { once: true });
      }

      entry!.subscribers.add(sub);

      entry!.promise.then(
        (val) => {
          cleanup();
          resolve(val);
        },
        (err) => {
          cleanup();
          reject(err);
        }
      );
    });
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get totalCoalescedCount(): number {
    return this._totalCoalescedCount;
  }

  clear(): void {
    for (const entry of this.inFlight.values()) {
      entry.controller.abort(new DOMException('Request coalescer cleared', 'AbortError'));
    }
    this.inFlight.clear();
    this._totalCoalescedCount = 0;
  }
}

export const globalRequestCoalescer = new RequestCoalescer();

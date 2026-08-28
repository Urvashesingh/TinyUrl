/**
 * Size-and-time batcher.
 *
 * Analytics writes are the classic case for batching: each event is tiny and
 * worthless on its own, and a row-at-a-time INSERT spends far more on round
 * trips and WAL than on the data. Batching amortises both.
 *
 * Two triggers, because either one alone is wrong: flushing only on size
 * strands the last few events indefinitely when traffic goes quiet, and
 * flushing only on time gives up throughput under load.
 */
export interface BatcherOptions<T> {
  maxSize: number;
  maxDelayMs: number;
  flush: (items: T[]) => Promise<void>;
  onError?: (error: unknown, items: T[]) => void;
}

export interface Batcher<T> {
  add(item: T): void;
  /** Flush whatever is buffered and wait for it to land. */
  drain(): Promise<void>;
  size(): number;
}

export function createBatcher<T>(options: BatcherOptions<T>): Batcher<T> {
  let buffer: T[] = [];
  let timer: NodeJS.Timeout | null = null;
  // Serialises flushes so two of them cannot interleave and reorder writes.
  let inFlight: Promise<void> = Promise.resolve();

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flushNow(): Promise<void> {
    clearTimer();

    if (buffer.length === 0) {
      return inFlight;
    }

    const batch = buffer;
    buffer = [];

    inFlight = inFlight
      .then(() => options.flush(batch))
      .catch((error) => {
        // The batch is lost. Surfacing it is the caller's decision -- retrying
        // in place would grow the buffer without bound during an outage, which
        // trades lost analytics for a dead process.
        options.onError?.(error, batch);
      });

    return inFlight;
  }

  return {
    add(item) {
      buffer.push(item);

      if (buffer.length >= options.maxSize) {
        void flushNow();
        return;
      }

      if (!timer) {
        timer = setTimeout(() => void flushNow(), options.maxDelayMs);
        // Never let a pending flush hold the process open on shutdown.
        timer.unref();
      }
    },

    async drain() {
      await flushNow();
    },

    size() {
      return buffer.length;
    },
  };
}

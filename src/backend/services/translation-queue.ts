export interface SerialTranslationQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  readonly pending: number;
}

export interface TranslationQueueRegistry {
  getQueue(key: string): SerialTranslationQueue;
  clearQueue(key: string): void;
}

export function createSerialTranslationQueue(): SerialTranslationQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let pendingCount = 0;

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      pendingCount += 1;
      const run = async () => {
        try {
          return await task();
        } finally {
          pendingCount -= 1;
        }
      };

      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },
    get pending() {
      return pendingCount;
    }
  };
}

export function createTranslationQueueRegistry(): TranslationQueueRegistry {
  const queues = new Map<string, SerialTranslationQueue>();

  return {
    getQueue(key) {
      let queue = queues.get(key);
      if (!queue) {
        queue = createSerialTranslationQueue();
        queues.set(key, queue);
      }
      return queue;
    },
    clearQueue(key) {
      queues.delete(key);
    }
  };
}


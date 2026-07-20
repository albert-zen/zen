export class AsyncIteratorAbortedError extends Error {
  constructor() {
    super('Async iterator consumption aborted');
    this.name = 'AsyncIteratorAbortedError';
  }
}

export function isAsyncIteratorAbortedError(cause: unknown): cause is AsyncIteratorAbortedError {
  return cause instanceof AsyncIteratorAbortedError;
}

export async function consumeAbortableAsyncIterator<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal | undefined,
  consume: (value: T) => Promise<void | false>
): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();

  while (true) {
    if (signal?.aborted) {
      closeIterator(iterator);
      throw new AsyncIteratorAbortedError();
    }

    const next = await nextOrAbort(iterator, signal);

    if (next === aborted) {
      closeIterator(iterator);
      throw new AsyncIteratorAbortedError();
    }

    if (next.done) return;
    if (signal?.aborted) {
      closeIterator(iterator);
      throw new AsyncIteratorAbortedError();
    }

    if ((await consume(next.value)) === false) {
      closeIterator(iterator);
      return;
    }
  }
}

const aborted = Symbol('aborted');

async function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<T> | typeof aborted> {
  if (!signal) return await iterator.next();
  if (signal.aborted) return aborted;

  return await new Promise<IteratorResult<T> | typeof aborted>((resolve, reject) => {
    const onAbort = () => resolve(aborted);
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator
      .next()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  if (!iterator.return) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Cleanup is best-effort; shutdown must not wait for a non-cooperative iterator.
  }
}

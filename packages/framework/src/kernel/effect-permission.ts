import { AsyncIteratorAbortedError } from './abortable-async-iterator.js';

/** Synchronous fence immediately before evaluating an external effect. */
export function assertEffectPermitted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AsyncIteratorAbortedError();
  }
}

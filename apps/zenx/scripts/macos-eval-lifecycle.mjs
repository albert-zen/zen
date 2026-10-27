// Shared evaluation bounds, with no Electron or user-desktop operations.
export const MAX_MACOS_EVAL_MS = 300_000;
export function evaluationDuration(name, value, fallback, allowZero = false) {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value))
    throw Error(`${name} must be an integer duration`);
  const milliseconds = Number(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < (allowZero ? 0 : 1) ||
    milliseconds > MAX_MACOS_EVAL_MS
  )
    throw Error(
      `${name} must be ${allowZero ? 0 : 1}–${MAX_MACOS_EVAL_MS} milliseconds`,
    );
  return milliseconds;
}
export function bounded(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function pause(milliseconds, signal) {
  let timer;
  try {
    await bounded(
      new Promise((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

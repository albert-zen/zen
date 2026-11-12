/** Wait for the actual focus transition, including deferred portal teardown. */
export function waitForFocus(
  target: HTMLElement,
  timeoutMs = 1_000,
): Promise<void> {
  if (target.ownerDocument.activeElement === target) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      target.removeEventListener("focus", onFocus);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onFocus = () => {
      if (target.ownerDocument.activeElement !== target) return;
      cleanup();
      resolve();
    };
    target.addEventListener("focus", onFocus);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Focus was not restored within ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

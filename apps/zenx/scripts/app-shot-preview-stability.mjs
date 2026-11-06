/** Serialized into the synthetic preview page; never disables production motion. */
export async function settleAppShotPreview(timeoutMs = 2000) {
  await document.fonts.ready;
  const frames = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  const deadline = performance.now() + timeoutMs;
  await frames();
  while (true) {
    const animations = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return (
        Number.isFinite(end) &&
        (animation.pending || animation.playState === "running")
      );
    });
    if (!animations.length) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error("App Shot preview motion did not settle");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("App Shot preview motion did not settle")),
        remaining,
      );
      Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await frames();
  }
}

/** Settle before measuring a synthetic click; never retries or dispatches input. */
export async function appShotPreviewClickPosition(selector, settle) {
  await settle();
  let element = document.querySelector(selector);
  if (!element || element.disabled)
    throw new Error("Missing or disabled fixture button");
  element.scrollIntoView({ block: "center", behavior: "instant" });
  await settle();
  // Scrolling and the preceding disclosure can change layout or replace a node.
  element = document.querySelector(selector);
  if (!element || element.disabled)
    throw new Error("Missing or disabled fixture button");
  const r = element.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  if (
    !r.width ||
    !r.height ||
    !element.contains(document.elementFromPoint(x, y))
  )
    throw new Error("Fixture button is obscured");
  return { x, y };
}

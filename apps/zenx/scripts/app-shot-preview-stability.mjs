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

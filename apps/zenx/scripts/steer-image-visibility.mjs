/** Browser-side geometry probe, serialized into the synthetic fixture by CDP. */
export function measureImageVisibility(image) {
  const rect = image.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  let painted = image.complete && image.naturalWidth > 0;
  for (let node = image; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility !== "visible" ||
      Number(style.opacity) === 0 ||
      style.contentVisibility === "hidden"
    )
      painted = false;
    const box = node.getBoundingClientRect();
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  const visibleWidth = Math.max(0, right - left),
    visibleHeight = Math.max(0, bottom - top);
  const coverage =
    rect.width * rect.height > 0
      ? (visibleWidth * visibleHeight) / (rect.width * rect.height)
      : 0;
  const hit =
    visibleWidth > 0 && visibleHeight > 0
      ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      : null;
  const unobscured = hit === image || image.contains(hit);
  return {
    width: rect.width,
    height: rect.height,
    left: rect.left,
    top: rect.top,
    visibleWidth,
    visibleHeight,
    coverage,
    painted,
    unobscured,
    visible:
      painted &&
      unobscured &&
      visibleWidth >= 16 &&
      visibleHeight >= 16 &&
      coverage >= 0.9,
  };
}

/** Preserve failure receipts while making incomplete cleanup fail the CI step. */
export function captureExitCode(captureStatus, closed) {
  return captureStatus === "passed" && closed ? 0 : 1;
}

/** Long text may exceed the shelf viewport; require a painted reachable region. */
export function measureBubbleVisibility(image) {
  const rect = image.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  let painted = true;
  for (let node = image; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility !== "visible" ||
      Number(style.opacity) === 0 ||
      style.contentVisibility === "hidden"
    )
      painted = false;
    const box = node.getBoundingClientRect();
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  const visibleWidth = Math.max(0, right - left),
    visibleHeight = Math.max(0, bottom - top);
  const coverage =
    rect.width * rect.height > 0
      ? (visibleWidth * visibleHeight) / (rect.width * rect.height)
      : 0;
  const hit =
    visibleWidth > 0 && visibleHeight > 0
      ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      : null;
  const unobscured = hit === image || image.contains(hit);
  return {
    width: rect.width,
    height: rect.height,
    left: rect.left,
    top: rect.top,
    visibleWidth,
    visibleHeight,
    coverage,
    painted,
    unobscured,
    visible: painted && unobscured && visibleWidth >= 16 && visibleHeight >= 16,
  };
}

// Presentation-only geometry, not browser ownership or conversation state.
const layers = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function registerNativeViewOverlay(layer: HTMLElement): () => void {
  layers.add(layer);
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(notify);
  observer?.observe(layer);
  notify();
  return () => {
    observer?.disconnect();
    layers.delete(layer);
    notify();
  };
}

export function subscribeNativeViewOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function nativeViewOverlapsOverlay(rect: DOMRect): boolean {
  return [...layers].some((layer) => {
    if (!layer.isConnected) return false;
    const overlay = layer.getBoundingClientRect();
    return (
      overlay.width > 0 &&
      overlay.height > 0 &&
      rect.left < overlay.right &&
      rect.right > overlay.left &&
      rect.top < overlay.bottom &&
      rect.bottom > overlay.top
    );
  });
}

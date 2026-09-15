/** One native drag owns its preview, edge scrolling and cancellation listeners. */
export function startSidebarDrag(
  source: HTMLElement,
  transfer: DataTransfer,
  label: string,
  onFinish: () => void,
): () => void {
  const scroller = source.closest<HTMLElement>(".sidebar-scroll");
  const preview = document.createElement("div");
  preview.className = "sidebar-drag-preview";
  preview.textContent = label;
  document.body.append(preview);
  transfer.setDragImage?.(preview, -12, -8);
  let pointer: { x: number; y: number } | null = null;
  let frame: number | undefined;
  let previousTime = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    preview.remove();
    document.removeEventListener("dragover", track, true);
    document.removeEventListener("dragleave", leave);
    document.removeEventListener("drop", finish);
    document.removeEventListener("dragend", finish);
    document.removeEventListener("keydown", escape);
    window.removeEventListener("blur", finish);
    onFinish();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") finish();
  };
  const track = (event: DragEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
  };
  const leave = (event: DragEvent) => {
    if (event.relatedTarget === null) pointer = null;
  };
  const tick = (time: number) => {
    // The browser captures the custom image synchronously at drag start.
    preview.remove();
    const elapsed = previousTime === 0 ? 0 : Math.min(time - previousTime, 32);
    previousTime = time;
    if (scroller && pointer) {
      const bounds = scroller.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const edge = Math.min(40, (bottom - top) / 3);
      if (
        edge > 0 &&
        pointer.x >= bounds.left &&
        pointer.x <= bounds.right &&
        pointer.y >= top &&
        pointer.y <= bottom
      ) {
        const speed =
          pointer.y < top + edge
            ? -600 * (1 - (pointer.y - top) / edge)
            : pointer.y > bottom - edge
              ? 600 * (1 - (bottom - pointer.y) / edge)
              : 0;
        scroller.scrollTop += (speed * elapsed) / 1000;
      }
    }
    if (!finished) frame = window.requestAnimationFrame(tick);
  };
  document.addEventListener("dragover", track, true);
  document.addEventListener("dragleave", leave);
  document.addEventListener("drop", finish);
  document.addEventListener("dragend", finish);
  document.addEventListener("keydown", escape);
  window.addEventListener("blur", finish);
  if (window.requestAnimationFrame) frame = window.requestAnimationFrame(tick);
  return finish;
}

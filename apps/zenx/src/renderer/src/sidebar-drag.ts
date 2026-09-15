/** One native drag owns its preview, edge scrolling and cancellation listeners. */
export function startSidebarDrag(
  source: HTMLElement,
  transfer: DataTransfer,
  label: string,
  kind: "project" | "thread",
  grab: { clientX: number; clientY: number },
  onFinish: () => void,
): () => void {
  const scroller = source.closest<HTMLElement>(".sidebar-scroll");
  const preview = document.createElement("div");
  preview.className = "sidebar-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  const bounds = source.getBoundingClientRect();
  // Keep the original row footprint and pointer hotspot: no jump on pickup.
  preview.style.width = `${bounds.width}px`;
  preview.style.height = `${bounds.height}px`;
  if (kind === "thread") {
    preview.classList.add("sidebar-drag-preview-thread");
    preview.inert = true;
    // Reuse the visible row, including title and provider/model styling.
    // Clone only its contents container, never its adjacent menu controls.
    const row = source
      .querySelector<HTMLElement>(".thread-row")!
      .cloneNode(true) as HTMLElement;
    row.removeAttribute("id");
    for (const element of row.querySelectorAll("[id]"))
      element.removeAttribute("id");
    preview.append(row);
  } else {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.5");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.dataset.kind = kind;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M1.8 4.2C1.8 3.5 2.3 3 3 3h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2Z",
    );
    icon.append(path);
    const title = document.createElement("span");
    title.textContent = label;
    preview.append(icon, title);
  }
  document.body.append(preview);
  transfer.setDragImage?.(
    preview,
    grab.clientX - bounds.left,
    grab.clientY - bounds.top,
  );
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

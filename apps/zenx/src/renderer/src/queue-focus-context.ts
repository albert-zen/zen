/** Reveal the message being operated on, without scrolling the transcript. */
export function revealQueueFocusContext(target: HTMLElement): void {
  const row = target.closest<HTMLElement>(".queue-row");
  const tray = row?.closest<HTMLElement>(".pending-tray");
  if (!row || !tray || tray.clientHeight <= 0) return;
  const bounds = tray.getBoundingClientRect();
  const header = row
    .closest(".queue-shelf")
    ?.querySelector(".queue-shelf-header");
  const padding =
    Number.parseFloat(getComputedStyle(tray).scrollPaddingBlockStart) || 0;
  const top =
    bounds.top +
    tray.clientTop +
    Math.max(padding, header?.getBoundingClientRect().height ?? 0) +
    2;
  const bottom = bounds.top + tray.clientTop + tray.clientHeight - 2;
  if (bottom <= top) return;
  const message = row.getBoundingClientRect();
  // An expanded image/gallery or long message may exceed the available space.
  // In that case preserve the current action instead of aligning an unreachable
  // message edge and hiding the focused control behind a sticky heading.
  const subject =
    message.height <= bottom - top ? message : target.getBoundingClientRect();
  const delta =
    subject.top < top
      ? subject.top - top
      : subject.bottom > bottom
        ? subject.bottom - bottom
        : 0;
  if (delta === 0) return;
  tray.scrollTop = Math.max(
    0,
    Math.min(tray.scrollHeight - tray.clientHeight, tray.scrollTop + delta),
  );
}

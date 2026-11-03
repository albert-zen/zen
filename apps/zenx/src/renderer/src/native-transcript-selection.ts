import { readTranscriptAnchor } from "./transcript-viewport-pins.js";

/** Editors retain their native local selection; a visible transcript owns page selection. */
export function ownsNativeTranscriptSelection(viewport: HTMLElement): boolean {
  const document = viewport.ownerDocument;
  const view = viewport.closest(".thread-view") ?? viewport;
  if (view.closest("[hidden],[aria-hidden='true'],[inert]")) return false;
  const active = document.activeElement;
  if (
    active?.closest(
      "input,textarea,select,[contenteditable='true'],.cm-editor,.xterm,[role='dialog'],[data-thread-find-ignore]",
    )
  )
    return false;
  if (active === document.body || active === document.documentElement) {
    const primary = Array.from(document.querySelectorAll(".thread-view")).find(
      (element) => !element.closest("[hidden],[aria-hidden='true'],[inert]"),
    );
    return !primary || primary === view;
  }
  return active !== null && view.contains(active);
}

export function transcriptSelectionIntersects(viewport: HTMLElement): boolean {
  const selection = viewport.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  ).some((range) => range.intersectsNode(viewport));
}

/** Used only during an explicit full-DOM selection transition, never ordinary Send. */
export function alignTranscriptSelectionAnchor(
  viewport: HTMLElement,
  anchor: ReturnType<typeof readTranscriptAnchor>,
): void {
  if (!anchor) return;
  const row = Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
  ).find((element) => element.dataset.transcriptRowKey === anchor.key);
  if (row)
    viewport.scrollTop +=
      row.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      anchor.offset;
}

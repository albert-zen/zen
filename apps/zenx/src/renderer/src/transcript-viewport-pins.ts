/** Inspect mounted rows only. This is reading protection, never a history projection. */
export function protectedTranscriptRows(
  viewport: HTMLElement,
  protectMounted: boolean,
): string[] {
  const selection = viewport.ownerDocument.getSelection();
  const ranges =
    selection?.isCollapsed === false
      ? Array.from({ length: selection.rangeCount }, (_, i) =>
          selection.getRangeAt(i),
        )
      : [];
  const focused = viewport.ownerDocument.activeElement;
  return Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
  )
    .filter(
      (row) =>
        protectMounted ||
        row.contains(focused) ||
        ranges.some((range) => range.intersectsNode(row)),
    )
    .flatMap((row) =>
      row.dataset.transcriptRowKey ? [row.dataset.transcriptRowKey] : [],
    );
}

export interface TranscriptAnchor {
  key: string;
  /** Pixels between the row's top and the viewport top, not an estimated document offset. */
  offset: number;
}
export function readTranscriptAnchor(
  viewport: HTMLElement,
): TranscriptAnchor | null {
  const top = viewport.getBoundingClientRect().top;
  const rows = Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
  );
  const row = rows
    .filter((row) => row.getBoundingClientRect().bottom > top)
    .sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    )[0];
  const key = row?.dataset.transcriptRowKey;
  return row && key
    ? { key, offset: row.getBoundingClientRect().top - top }
    : null;
}

/** A scrollable tool/code region owns its input independently of the transcript. */
export function isNestedTranscriptScroll(
  target: EventTarget | null,
  transcript: HTMLElement,
): boolean {
  const ElementType = transcript.ownerDocument.defaultView?.Element;
  for (
    let element = ElementType && target instanceof ElementType ? target : null;
    element && element !== transcript;
    element = element.parentElement
  ) {
    if (
      element.scrollHeight > element.clientHeight &&
      /auto|scroll/.test(getComputedStyle(element).overflowY)
    )
      return true;
  }
  return false;
}

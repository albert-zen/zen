/** Align the scroller's content box, leaving its native scrollbar in the gutter. */
export function steerPreviewColumn(
  column: { left: number; width: number },
  shelfLeft: number,
  scrollbarWidth: number,
) {
  return {
    left: column.left - shelfLeft,
    width: column.width + Math.max(0, scrollbarWidth),
  };
}

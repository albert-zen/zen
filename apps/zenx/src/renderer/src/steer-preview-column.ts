/** Align the content box, leaving native scrollbars and borders in the gutter. */
export function steerPreviewColumn(
  column: { left: number; width: number },
  shelfLeft: number,
  nonContentWidth: number,
) {
  return {
    left: column.left - shelfLeft,
    width: column.width + Math.max(0, nonContentWidth),
  };
}

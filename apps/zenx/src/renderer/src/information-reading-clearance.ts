/** Fit the card beside the reading column without reducing its width. */
export function informationReadingClearance(input: {
  viewportLeft: number;
  cardRight: number;
  unshiftedReadingLeft: number;
  readingWidth: number;
  resourceOpen: boolean;
  direction: string;
  open: boolean;
}) {
  const none = { cardWidth: undefined, shift: 0 };
  if (!input.open || input.resourceOpen || input.direction !== "ltr")
    return none;
  const { viewportLeft, cardRight, unshiftedReadingLeft, readingWidth } = input;
  if (
    ![viewportLeft, cardRight, unshiftedReadingLeft, readingWidth].every(
      Number.isFinite,
    ) ||
    readingWidth <= 0
  )
    return none;
  const cardWidth = 320;
  const shift = Math.max(
    0,
    unshiftedReadingLeft + readingWidth + 16 - (cardRight - cardWidth),
  );
  if (unshiftedReadingLeft - shift < viewportLeft + 24) return none;
  return { cardWidth, shift };
}

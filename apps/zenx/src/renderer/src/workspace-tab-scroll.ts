/**
 * Horizontal scroll position for the workspace tab rail.
 *
 * The rail scrolls instead of shrinking tabs, so the tab at the leading edge
 * can end up holding a narrow sliver of its own content. That sliver reads as a
 * tab whose icon disappeared, because the icon is the leading element of a tab.
 * Keep whole tabs at the leading edge whenever the active tab stays visible.
 */

export interface TabExtent {
  /** Offset of the tab's leading edge inside the scrolled content. */
  start: number;
  /** Offset of the tab's trailing edge inside the scrolled content. */
  end: number;
}

export function revealTabScroll({
  tabs,
  active,
  clientWidth,
  scrollLeft,
  scrollWidth,
}: {
  tabs: readonly TabExtent[];
  active: number;
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}): number {
  const maxScroll = Math.max(0, Math.ceil(scrollWidth - clientWidth));
  const target = tabs[active];
  if (target === undefined || clientWidth <= 0 || maxScroll === 0) return 0;
  let next = scrollLeft;
  if (target.start < next || target.end - target.start > clientWidth)
    next = target.start;
  else if (target.end > next + clientWidth) next = target.end - clientWidth;
  next = Math.max(0, Math.min(next, maxScroll));
  if (next <= 0) return 0;
  // The leading edge now cuts through a tab unless it lands on a tab boundary.
  // Move it onto that tab's boundary when the active tab stays fully visible,
  // so a tab never appears as a bare fragment of its own title.
  const straddling = tabs.find(
    (tab) => tab.start < next - 0.5 && tab.end > next + 0.5,
  );
  if (straddling !== undefined) {
    if (straddling.end <= target.start + 0.5)
      return Math.min(straddling.end, maxScroll);
    if (target.end <= straddling.start + clientWidth + 0.5)
      return Math.min(Math.max(straddling.start, 0), maxScroll);
  }
  return next;
}

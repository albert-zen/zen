/** The dock's desktop editor keeps a 480px content floor. Its shell adds
 * 2px border + 16px input inset. Recover space symmetrically from the shared
 * 24px conversation gutters, never from the transcript scrollbar or dock.
 * Below this budget the layout still needs its normal overlay/split policy.
 */
export function informationConversationGutter(
  scrollportWidth: number,
  dockedDesktop: boolean,
): number | null {
  if (
    !dockedDesktop ||
    !Number.isFinite(scrollportWidth) ||
    scrollportWidth <= 0
  )
    return null;
  return Math.min(24, Math.max(16, (scrollportWidth - 498) / 2));
}

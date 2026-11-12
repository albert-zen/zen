/** Selection routing is renderer presentation only; it never creates a native Thread. */
export function chooseSideChatQuoteTarget<T extends { id: string }>(
  targets: readonly T[],
  selectedId: string | undefined,
): T | null {
  return (
    targets.find((target) => target.id === selectedId) ??
    (targets.length === 1 ? targets[0]! : null)
  );
}

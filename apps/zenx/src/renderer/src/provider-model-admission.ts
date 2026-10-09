// Match the Host profile limit before allowing either model-add path.
export const MAX_MODELS_PER_PROVIDER = 1_024;

export function remainingProviderModelSlots(modelCount: number): number {
  return Math.max(0, MAX_MODELS_PER_PROVIDER - modelCount);
}

// Recheck the current state inside React's functional updater: a selection may
// have been made while the draft still had more room.
export function appendProviderModelRows<T>(
  current: T[],
  additions: readonly T[],
): T[] {
  const admitted = additions.slice(
    0,
    remainingProviderModelSlots(current.length),
  );
  return admitted.length === 0 ? current : [...current, ...admitted];
}

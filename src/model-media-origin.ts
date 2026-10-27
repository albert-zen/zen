import type { RecoveryMediaOccurrence } from "./item.js";
/** Ephemeral typed compiler provenance; not serialized and never inferred from a hash alone. */
const origins = new WeakMap<object, RecoveryMediaOccurrence>();
export function bindModelMediaOrigin(
  part: object,
  origin: RecoveryMediaOccurrence,
): void {
  origins.set(part, { ...origin });
}
export function modelMediaOrigin(
  part: object,
): RecoveryMediaOccurrence | undefined {
  return origins.get(part);
}

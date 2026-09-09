import type { CanonicalItem, JsonValue } from "./item.js";

export const MAX_CODE_STATE_VALUE_BYTES = 256 * 1024;
export const MAX_CODE_STATE_BYTES = 2 * 1024 * 1024;
export const MAX_CODE_STATE_KEYS = 128;

/** This view is reconstructed from canonical writes, never a second state authority. */
export function codeStateFromItems(items: readonly CanonicalItem[]): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const item of items) {
    if (item.type === "code_state") values[item.key] = structuredClone(item.value);
  }
  return values;
}

export function validateCodeStateWrite(values: Record<string, JsonValue>, key: string, value: JsonValue): void {
  if (key.length === 0 || key.length > 160) throw new Error("store key must contain 1-160 characters");
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_CODE_STATE_VALUE_BYTES)
    throw new Error("store value exceeds 256 KiB JSON limit");
  const next = Object.assign(Object.create(null), values, { [key]: value }) as Record<string, JsonValue>;
  if (Object.keys(next).length > MAX_CODE_STATE_KEYS || Buffer.byteLength(JSON.stringify(next)) > MAX_CODE_STATE_BYTES)
    throw new Error("store exceeds thread limit (128 keys / 2 MiB JSON)");
}

import type { JsonValue } from "../../../../../src/item.js";
export const MODEL_REF = {
  type: "string",
  pattern: "^r[1-9][0-9]*$",
  description:
    "Exact scoped ref from a previous read. Retired refs require a fresh read.",
};
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function object(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (!result) throw Error("Expected a typed object");
  return result;
}
export function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export function pick(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
}
export function only(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (Object.keys(value).some((field) => !fields.includes(field)))
    throw Error("Unsupported model facade field");
}
/** Only schema-owned required lists and known named properties, never string data. */
export function renameRequired(
  schema: Record<string, unknown>,
  from: string,
  to: string,
): void {
  if (Array.isArray(schema.required))
    schema.required = schema.required.map((field) =>
      field === from ? to : field,
    );
  for (const key of ["oneOf", "anyOf", "allOf"])
    if (Array.isArray(schema[key]))
      for (const branch of schema[key])
        if (record(branch)) renameRequired(object(branch), from, to);
}
export function renameField(
  schema: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const fields = record(schema.properties);
  if (!fields || !(from in fields)) return;
  delete fields[from];
  fields[to] = structuredClone(MODEL_REF);
  renameRequired(schema, from, to);
}

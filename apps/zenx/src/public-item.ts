/** Respect structured visibility at every depth without interpreting text strings. */
export function publicItemValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicItemValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const entries =
    record.contentVisibility === "opaque"
      ? [
          "id",
          "threadId",
          "turnId",
          "createdAt",
          "type",
          "role",
          "contentVisibility",
          "summary",
        ]
          .filter((key) => Object.hasOwn(record, key))
          .map((key) => [key, record[key]] as const)
      : Object.entries(record);
  return Object.fromEntries(
    entries.map(([key, child]) => [key, publicItemValue(child)]),
  );
}

/** Observation controls are separate from the code runner's execution lifetime. */
export function codeExecutionOptions(code: unknown): {
  yieldTimeMs?: number;
  timeoutMs?: number;
  previewBytes?: number;
} {
  if (typeof code !== "string") return {};
  const match = /^[ \t]*\/\/ @exec:([^\r\n]*)/.exec(code);
  if (match === null) return {};
  const options: unknown = JSON.parse(match[1]!);
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new Error("@exec options must be an object");
  const result: {
    yieldTimeMs?: number;
    timeoutMs?: number;
    previewBytes?: number;
  } = {};
  for (const [key, value] of Object.entries(options)) {
    const limit =
      key === "yield_time_ms"
        ? 180000
        : key === "timeout_ms"
          ? 86400000
          : key === "max_output_tokens"
            ? 100000
            : 0;
    if (
      !limit ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > limit
    )
      throw new Error(`Invalid @exec option ${key}`);
    if (key === "yield_time_ms") result.yieldTimeMs = value;
    if (key === "timeout_ms") result.timeoutMs = value;
    // A conservative UTF-8 preview budget; full captured output remains in the spool.
    if (key === "max_output_tokens") result.previewBytes = value * 4;
  }
  return result;
}

/** Owner-readable diagnostic projection, not an export or an authority signal.
 * Explicit limits bound UI/IPC work; markers mean this is not the raw artifact. */
export function localErrorDetail(reason: unknown): string {
  const seen = new WeakSet<object>();
  let remaining = 65_536;
  let entries = 256;
  const text = (value: string): string => {
    if (value.length <= remaining) {
      remaining -= value.length;
      return value;
    }
    const result = value.slice(0, remaining);
    remaining = 0;
    return `${result}\n[diagnostic text limit reached]`;
  };
  const visit = (value: unknown, depth: number, headers = false): unknown => {
    if (typeof value === "string") return text(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return value;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[circular/shared reference]";
    if (depth >= 8 || entries-- <= 0 || remaining === 0)
      return "[diagnostic traversal limit reached]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    // Error fields are non-enumerable; own descriptors avoid invoking getters.
    const keys = [
      ...new Set([
        "name",
        "message",
        "stack",
        "code",
        "cause",
        "errors",
        ...Object.keys(value),
      ]),
    ];
    for (const key of keys) {
      if (entries-- <= 0 || remaining === 0) {
        result["[remaining fields]"] = "[diagnostic traversal limit reached]";
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (
        headers &&
        /^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(key)
      ) {
        result[text(key)] = "[authentication header omitted]";
        continue;
      }
      // V8 exposes its lazy Error stack via a native getter. Do not run custom accessors.
      if (
        key === "stack" &&
        value instanceof Error &&
        descriptor.get &&
        Function.prototype.toString
          .call(descriptor.get)
          .includes("[native code]")
      ) {
        const safeNameAndMessage = ["name", "message"].every((field) => {
          let owner: object | null = value;
          while (owner !== null) {
            const fieldDescriptor = Object.getOwnPropertyDescriptor(
              owner,
              field,
            );
            if (fieldDescriptor)
              return (
                "value" in fieldDescriptor &&
                (typeof fieldDescriptor.value === "string" ||
                  fieldDescriptor.value === undefined)
              );
            owner = Object.getPrototypeOf(owner);
          }
          return true;
        });
        if (!safeNameAndMessage) {
          result[text(key)] =
            "[lazy stack skipped: unsafe name/message accessor]";
          continue;
        }
        try {
          result[text(key)] = visit(descriptor.get.call(value), depth + 1);
        } catch {
          result[text(key)] = "[stack unavailable]";
        }
        continue;
      }
      result[text(key)] =
        "value" in descriptor
          ? visit(
              descriptor.value,
              depth + 1,
              /^(headers|requestHeaders|responseHeaders)$/i.test(key),
            )
          : "[accessor not evaluated]";
    }
    return result;
  };
  if (typeof reason === "string") return text(reason);
  try {
    const detail =
      reason !== null && typeof reason === "object"
        ? Object.getOwnPropertyDescriptor(reason, "localDiagnosticDetail")
        : undefined;
    if (detail && "value" in detail && typeof detail.value === "string")
      return text(detail.value);
    return JSON.stringify(visit(reason, 0), null, 2);
  } catch {
    return "[diagnostic inspection failed]";
  }
}

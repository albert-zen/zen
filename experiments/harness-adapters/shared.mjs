export function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value;
}
export function scoped(engine, cwd) {
  requiredString(cwd, "cwd");
  return {
    cwd,
    ref(id) {
      return Object.freeze({ engine, id: requiredString(id, "session id") });
    },
    id(ref) {
      if (ref?.engine !== engine)
        throw new Error("Session engine does not match adapter");
      return requiredString(ref.id, "session id");
    },
    start(input) {
      requiredString(input?.text, "text");
      requiredString(input?.messageId, "messageId");
      if (input.mode !== "start") throw new Error("Unsupported send mode");
    },
    create(input = {}) {
      if (input.cwd !== undefined && input.cwd !== cwd)
        throw new Error("cwd does not match bound adapter");
    },
  };
}
export async function unsupported() {
  throw new Error("Unsupported capability in this adapter slice");
}
export function sdkData(result) {
  if (result?.error !== undefined) throw result.error;
  if (result?.data === undefined) throw new Error("Malformed SDK response");
  return result.data;
}

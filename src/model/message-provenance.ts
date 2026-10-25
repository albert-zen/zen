/** Disposable identity metadata for debugging; never serialized or journaled. */
const sources = new WeakMap<object, string>();

export interface SerializedMessageSource {
  itemId: string;
  container: "messages" | "input";
  index: number;
}

export function markMessageSource<T extends object>(
  message: T,
  itemId: string,
): T {
  sources.set(message, itemId);
  return message;
}

export function copyMessageSource<T extends object>(
  source: object,
  target: T,
): T {
  const itemId = sources.get(source);
  return itemId === undefined ? target : markMessageSource(target, itemId);
}

export function serializedMessageSource(
  message: object,
  container: SerializedMessageSource["container"],
  index: number,
): SerializedMessageSource[] {
  const itemId = sources.get(message);
  return itemId === undefined ? [] : [{ itemId, container, index }];
}

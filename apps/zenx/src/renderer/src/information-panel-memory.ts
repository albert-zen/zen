/** Window-local information visibility, separate from durable workspace layout. */
const windows = new WeakMap<object, Map<string, boolean>>();
function states() {
  let value = windows.get(window);
  if (!value) windows.set(window, (value = new Map()));
  return value;
}
export function rememberInformationOpen(ownerKey: string, open: boolean): void {
  states().set(ownerKey, open);
}
export function readInformationOpen(ownerKey: string): boolean {
  return states().get(ownerKey) ?? false;
}

const revealTokens = new WeakMap<object, Map<string, number>>();
export function consumeInformationReveal(
  ownerKey: string,
  token: number,
): boolean {
  let seen = revealTokens.get(window);
  if (!seen) revealTokens.set(window, (seen = new Map()));
  if (token <= (seen.get(ownerKey) ?? 0)) return false;
  seen.set(ownerKey, token);
  return true;
}

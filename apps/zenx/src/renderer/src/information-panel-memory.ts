/**
 * Renderer-local visibility memory for the Thread/Room information surface.
 * Keyed by the same owner identity the Host already uses; never durable Thread
 * state and never the retired pin preference.
 */
const openByOwner = new Map<string, boolean>();

export function rememberInformationOpen(ownerKey: string, open: boolean): void {
  openByOwner.set(ownerKey, open);
}

export function readInformationOpen(ownerKey: string): boolean {
  return openByOwner.get(ownerKey) ?? false;
}

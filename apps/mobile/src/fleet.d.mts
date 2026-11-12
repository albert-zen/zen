import type { Host } from "./session.mjs";
export const FLEET_ADDRESSES_KEY: string;
export const FLEET_PREFERENCE_KEY: string;
export const MAX_REMOTE_HOSTS: number;
export function hostEndpoint(value: unknown): string;
export function makeHost(value: {
  id: unknown;
  endpoint: unknown;
  name?: unknown;
}): Host;
export function readSavedHosts(
  saved: string | null,
  reservedIds?: string[],
): Host[];
export function saveHosts(hosts: Host[], fixtureIds?: string[]): string;
export function deviceStatus(value: {
  fixture: boolean;
  selected: boolean;
  connection: string;
  pairing?: string;
}): string;
export function reconnectAvailable(value: {
  host: string | null;
  connection: string;
  command: string | null;
  pairing?: string;
}): boolean;

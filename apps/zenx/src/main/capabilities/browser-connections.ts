import type { BrowserConnectionSnapshot } from "../chrome-extension-bridge.js";
import type { UserBrowserConnection } from "./user-browser-provider.js";

/** App-owned native resources. Discovery contains no tab titles, URLs or profile data. */
export interface BrowserConnectionSource {
  connections(): BrowserConnectionSnapshot[];
  connectInstance(
    connectionId: string,
    generation: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserConnection>;
  onConnectionsChanged(listener: () => void): () => void;
}

export const unavailableBrowserConnections: BrowserConnectionSource = {
  connections: () => [],
  connectInstance: async () => {
    throw new Error("Enable and connect an external browser in Settings first");
  },
  onConnectionsChanged: () => () => {},
};

export function browserConnectionScopeKey(connectionId: string): string {
  return `browser-instance:${connectionId}`;
}

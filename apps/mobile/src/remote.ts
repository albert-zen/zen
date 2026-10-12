import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { RemoteHostTransport } from "./remote-core";
export { RemoteHostTransport } from "./remote-core";
export const nativeDependencies = {
  getSecret: (key: string) => SecureStore.getItemAsync(key),
  setSecret: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value),
  deleteSecret: (key: string) => SecureStore.deleteItemAsync(key),
  uuid: () => randomUUID(),
  fetch: globalThis.fetch.bind(globalThis),
  openSocket: (url: string, headers: Record<string, string>): WebSocket =>
    // React Native Android handshake options; never put bearer in URL/query.
    new (
      WebSocket as unknown as new (
        url: string,
        protocols: null,
        options: { headers: Record<string, string> },
      ) => WebSocket
    )(url, null, { headers }),
};

import type { AppServerHostStatus } from "../../main/app-server-manager.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../../protocol-client/index.js";

declare global {
  interface Window {
    zenx: {
      platform: NodeJS.Platform;
      protocol: {
        getStatus(): Promise<AppServerHostStatus>;
        request<M extends ClientRequestMethod>(
          method: M,
          params: ClientRequestParams[M],
        ): Promise<ClientRequestResults[M]>;
        onStatus(listener: (status: AppServerHostStatus) => void): () => void;
        onNotification(
          listener: <M extends ServerNotificationMethod>(
            method: M,
            params: ServerNotificationParams[M],
          ) => void,
        ): () => void;
      };
    };
  }
}

export {};

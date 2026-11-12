import { localErrorDetail } from "../local-error-detail.js";
import type {
  BrowserThreadRequest,
  BrowserThreadEvent,
} from "../main/capabilities/browser-thread-observation.js";
import type { BrowserObservationEnvelope } from "../main/browser-live-observation-ipc.js";
import { ipcChannels } from "./ipc.js";

const rejectionType = "zenx.browser-observation-rejection.v1";
export type BrowserObservationSubscribeReply = void | {
  type: typeof rejectionType;
  details: string;
};

/** Capture before Electron strips Error fields. Local UI data only, never a tool result. */
export function browserObservationSubscribeReply(
  subscribe: () => void,
): BrowserObservationSubscribeReply {
  try {
    subscribe();
  } catch (error) {
    return {
      type: rejectionType,
      details: localErrorDetail(error),
    };
  }
}

interface ObservationIpcPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    listener: (event: unknown, value: BrowserObservationEnvelope) => void,
  ): unknown;
  off(
    channel: string,
    listener: (event: unknown, value: BrowserObservationEnvelope) => void,
  ): unknown;
}

export function subscribeBrowserObservation(
  ipc: ObservationIpcPort,
  request: BrowserThreadRequest,
  listener: (event: BrowserThreadEvent) => void,
): () => void {
  const eventChannel = request.catalog
    ? ipcChannels.browserCatalogEvent
    : ipcChannels.browserLiveEvent;
  const subscribeChannel = request.catalog
    ? ipcChannels.browserCatalogSubscribe
    : ipcChannels.browserLiveSubscribe;
  const unsubscribeChannel = request.catalog
    ? ipcChannels.browserCatalogUnsubscribe
    : ipcChannels.browserLiveUnsubscribe;
  let active = true;
  const subscriptionId = crypto.randomUUID();
  const wrapped = (_event: unknown, value: BrowserObservationEnvelope) => {
    if (active && value.subscriptionId === subscriptionId)
      listener(value.event);
  };
  const failed = (details: string) => {
    if (active)
      listener({
        type: "status",
        status: "failed",
        message: "The live browser view could not be connected.",
        details,
      });
  };
  ipc.on(eventChannel, wrapped);
  void ipc.invoke(subscribeChannel, subscriptionId, request).then(
    (reply) => {
      if (
        reply &&
        typeof reply === "object" &&
        "type" in reply &&
        reply.type === rejectionType &&
        "details" in reply &&
        typeof reply.details === "string"
      )
        failed(reply.details);
    },
    (error) => failed(localErrorDetail(error)),
  );
  return () => {
    if (!active) return;
    active = false;
    ipc.off(eventChannel, wrapped);
    void ipc.invoke(unsubscribeChannel, subscriptionId);
  };
}

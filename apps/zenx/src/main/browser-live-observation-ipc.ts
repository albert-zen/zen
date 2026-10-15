import { classifyMessageLink } from "../external-link-policy.js";
import type {
  BrowserThreadRequest,
  BrowserThreadEvent,
  BrowserThreadListener,
} from "./capabilities/browser-thread-observation.js";
export interface BrowserLiveObservationSource {
  readBrowserTargetUrl?(threadId: string, targetId: string): Promise<string>;
  observeBrowserLive(
    request: BrowserThreadRequest,
    listener: BrowserThreadListener,
  ): () => void;
}
export interface BrowserObservationEnvelope {
  subscriptionId: string;
  event: BrowserThreadEvent;
}
export interface BrowserLiveObservationRenderer {
  isDestroyed(): boolean;
  send(channel: string, envelope: BrowserObservationEnvelope): void;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}
export class BrowserLiveObservationIpcBridge {
  readonly #source: BrowserLiveObservationSource;
  readonly #eventChannel: string;
  readonly #catalogOnly: boolean;
  readonly #subscriptions = new Map<
    BrowserLiveObservationRenderer,
    {
      id: string;
      request: BrowserThreadRequest;
      selectedId?: string;
      eligible: boolean;
      blocked: boolean;
      ready: boolean;
      epoch: number;
      opening: boolean;
      stop: () => void;
      destroyed: () => void;
    }
  >();
  constructor(
    source: BrowserLiveObservationSource,
    eventChannel: string,
    catalogOnly = false,
  ) {
    this.#catalogOnly = catalogOnly;
    this.#source = source;
    this.#eventChannel = eventChannel;
  }
  subscribe(
    renderer: BrowserLiveObservationRenderer,
    subscriptionId: string,
    request: BrowserThreadRequest,
  ): void {
    if (
      typeof subscriptionId !== "string" ||
      subscriptionId.length > 80 ||
      !subscriptionId ||
      !request ||
      typeof request.threadId !== "string" ||
      !request.threadId ||
      request.threadId.length > 512 ||
      typeof request.frames !== "boolean" ||
      (request.targetId !== undefined &&
        (typeof request.targetId !== "string" || request.targetId.length > 80))
    )
      throw new Error("Invalid Browser observation request");
    if (this.#catalogOnly && (request.frames || request.targetId !== undefined))
      throw new Error(
        "Browser catalog subscriptions are read-only target lists",
      );
    this.unsubscribe(renderer);
    const subscription = {
      id: subscriptionId,
      request: { ...request },
      selectedId: undefined as string | undefined,
      eligible: false,
      blocked: false,
      ready: false,
      epoch: 0,
      opening: false,
      stop: () => {},
      destroyed: () => this.unsubscribe(renderer),
    };
    this.#subscriptions.set(renderer, subscription);
    renderer.on("destroyed", subscription.destroyed);
    try {
      const stop = this.#source.observeBrowserLive(request, (event) => {
        if (
          this.#subscriptions.get(renderer) === subscription &&
          !renderer.isDestroyed()
        ) {
          if (event.type === "targets") {
            if (subscription.selectedId !== event.selectedId)
              subscription.epoch++;
            subscription.selectedId = event.selectedId;
            const target = event.targets.find(
              (value) => value.id === event.selectedId,
            );
            subscription.eligible =
              target?.canOpenExternally === true && !target.loading;
          } else if (
            event.type === "status" &&
            ["connecting", "failed", "unavailable"].includes(event.status)
          ) {
            subscription.epoch++;
            subscription.blocked = true;
          } else if (
            (event.type === "status" &&
              (event.status === "live" || event.status === "idle")) ||
            event.type === "snapshot"
          ) {
            subscription.blocked = false;
          }
          const ready = subscription.eligible && !subscription.blocked;
          if (subscription.ready && !ready) subscription.epoch++;
          subscription.ready = ready;
          renderer.send(this.#eventChannel, { subscriptionId, event });
        }
      });
      subscription.stop = stop;
      if (this.#subscriptions.get(renderer) !== subscription) stop();
    } catch (error) {
      this.unsubscribe(renderer, subscriptionId);
      throw error;
    }
  }
  async openExternal(
    renderer: BrowserLiveObservationRenderer,
    threadId: string,
    targetId: string,
    open: (url: string) => Promise<void>,
  ): Promise<void> {
    const subscription = this.#subscriptions.get(renderer);
    if (
      !subscription ||
      renderer.isDestroyed() ||
      !subscription.request.frames ||
      subscription.request.threadId !== threadId ||
      subscription.selectedId !== targetId ||
      !subscription.ready ||
      !this.#source.readBrowserTargetUrl
    )
      throw new Error("Browser page is not current");
    if (subscription.opening)
      throw new Error("Browser external opening is already pending");
    subscription.opening = true;
    const epoch = subscription.epoch;
    try {
      const raw = await this.#source.readBrowserTargetUrl(threadId, targetId);
      if (
        this.#subscriptions.get(renderer) !== subscription ||
        renderer.isDestroyed() ||
        subscription.epoch !== epoch ||
        !subscription.ready
      )
        throw new Error("Browser page is no longer current");
      const target = classifyMessageLink(raw);
      if (target.kind !== "browser")
        throw new Error(
          "Only current HTTP(S) Browser pages can be opened externally",
        );
      await open(target.value);
    } finally {
      subscription.opening = false;
    }
  }
  unsubscribe(
    renderer: BrowserLiveObservationRenderer,
    subscriptionId?: string,
  ): void {
    const subscription = this.#subscriptions.get(renderer);
    if (
      !subscription ||
      (subscriptionId !== undefined && subscriptionId !== subscription.id)
    )
      return;
    this.#subscriptions.delete(renderer);
    renderer.removeListener("destroyed", subscription.destroyed);
    subscription.stop();
  }
  close(): void {
    for (const renderer of [...this.#subscriptions.keys()])
      this.unsubscribe(renderer);
  }
}

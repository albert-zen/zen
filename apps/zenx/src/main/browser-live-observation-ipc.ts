import type {
  BrowserThreadRequest,
  BrowserThreadEvent,
  BrowserThreadListener,
} from "./capabilities/browser-thread-observation.js";
export interface BrowserLiveObservationSource {
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
  readonly #subscriptions = new Map<
    BrowserLiveObservationRenderer,
    { id: string; stop: () => void; destroyed: () => void }
  >();
  constructor(source: BrowserLiveObservationSource, eventChannel: string) {
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
    this.unsubscribe(renderer);
    const subscription = {
      id: subscriptionId,
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
        )
          renderer.send(this.#eventChannel, { subscriptionId, event });
      });
      subscription.stop = stop;
      if (this.#subscriptions.get(renderer) !== subscription) stop();
    } catch (error) {
      this.unsubscribe(renderer, subscriptionId);
      throw error;
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

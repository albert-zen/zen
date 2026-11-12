import type {
  ComputerThreadEvent,
  ComputerThreadListener,
  ComputerThreadRequest,
} from "./capabilities/computer-thread-observation.js";

export interface ComputerLiveObservationSource {
  observeComputerLive(
    request: ComputerThreadRequest,
    listener: ComputerThreadListener,
  ): () => void;
}
export interface ComputerObservationEnvelope {
  subscriptionId: string;
  event: ComputerThreadEvent;
}
export interface ComputerLiveObservationRenderer {
  isDestroyed(): boolean;
  send(channel: string, envelope: ComputerObservationEnvelope): void;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export class ComputerLiveObservationIpcBridge {
  readonly #source: ComputerLiveObservationSource;
  readonly #eventChannel: string;
  readonly #subscriptions = new Map<
    ComputerLiveObservationRenderer,
    { id: string; stop: () => void; destroyed: () => void }
  >();
  constructor(source: ComputerLiveObservationSource, eventChannel: string) {
    this.#source = source;
    this.#eventChannel = eventChannel;
  }

  subscribe(
    renderer: ComputerLiveObservationRenderer,
    subscriptionId: string,
    request: ComputerThreadRequest,
  ): void {
    if (
      typeof subscriptionId !== "string" ||
      !subscriptionId ||
      subscriptionId.length > 80 ||
      !request ||
      typeof request.threadId !== "string" ||
      !request.threadId ||
      request.threadId.length > 512 ||
      typeof request.frames !== "boolean" ||
      (request.targetId !== undefined &&
        (typeof request.targetId !== "string" || request.targetId.length > 80))
    )
      throw new Error("Invalid Computer observation request");
    this.unsubscribe(renderer);
    const subscription = {
      id: subscriptionId,
      stop: () => {},
      destroyed: () => this.unsubscribe(renderer),
    };
    this.#subscriptions.set(renderer, subscription);
    renderer.on("destroyed", subscription.destroyed);
    try {
      const stop = this.#source.observeComputerLive(request, (event) => {
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
    renderer: ComputerLiveObservationRenderer,
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
}

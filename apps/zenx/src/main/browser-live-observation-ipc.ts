import type {
  BrowserLiveObservationEvent,
  BrowserLiveObservationListener,
} from "./capabilities/browser-provider.js";

export interface BrowserLiveObservationSource {
  observeBrowserLive(listener: BrowserLiveObservationListener): () => void;
}

export interface BrowserLiveObservationRenderer {
  isDestroyed(): boolean;
  send(channel: string, event: BrowserLiveObservationEvent): void;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export class BrowserLiveObservationIpcBridge {
  readonly #source: BrowserLiveObservationSource;
  readonly #eventChannel: string;
  readonly #subscriptions = new Map<
    BrowserLiveObservationRenderer,
    { stop: () => void; destroyed: () => void }
  >();

  constructor(source: BrowserLiveObservationSource, eventChannel: string) {
    this.#source = source;
    this.#eventChannel = eventChannel;
  }

  subscribe(renderer: BrowserLiveObservationRenderer): void {
    this.unsubscribe(renderer);
    const destroyed = () => this.unsubscribe(renderer);
    renderer.on("destroyed", destroyed);
    try {
      const stop = this.#source.observeBrowserLive((event) => {
        if (!renderer.isDestroyed()) renderer.send(this.#eventChannel, event);
      });
      this.#subscriptions.set(renderer, { stop, destroyed });
    } catch (error) {
      renderer.removeListener("destroyed", destroyed);
      throw error;
    }
  }

  unsubscribe(renderer: BrowserLiveObservationRenderer): void {
    const subscription = this.#subscriptions.get(renderer);
    if (subscription === undefined) return;
    this.#subscriptions.delete(renderer);
    renderer.removeListener("destroyed", subscription.destroyed);
    subscription.stop();
  }

  close(): void {
    for (const renderer of [...this.#subscriptions.keys()])
      this.unsubscribe(renderer);
  }
}

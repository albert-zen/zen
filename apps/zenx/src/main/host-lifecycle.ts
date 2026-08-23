import {
  activationNeedsWindow,
  windowAllClosedDisposition,
  type ZenXDesktopPlatform,
} from "./desktop-lifecycle.js";

export type { ZenXDesktopPlatform } from "./desktop-lifecycle.js";

export interface ZenXHostLifecycleOptions {
  platform: ZenXDesktopPlatform;
  windowCount(): number;
  createWindow(): void;
  stopHost(): Promise<void>;
  finishQuit(): void;
  reportStopFailure?(error: unknown): void;
}

export class ZenXHostLifecycle {
  readonly #options: ZenXHostLifecycleOptions;
  #quitting = false;
  #quitReady = false;
  #quitCompletion: Promise<void> | undefined;

  constructor(options: ZenXHostLifecycleOptions) {
    this.#options = options;
  }

  get quitting(): boolean {
    return this.#quitting;
  }

  get quitCompletion(): Promise<void> {
    return this.#quitCompletion ?? Promise.resolve();
  }

  activate(): void {
    if (!this.#quitting && activationNeedsWindow(this.#options.windowCount())) {
      this.#options.createWindow();
    }
  }

  windowAllClosed(): {
    platform: ZenXDesktopPlatform;
    action: "keep-host-running";
  } {
    return {
      platform: this.#options.platform,
      action: windowAllClosedDisposition(this.#options.platform),
    };
  }

  beforeQuit(preventDefault: () => void): void {
    if (this.#quitReady) return;
    preventDefault();
    if (this.#quitCompletion !== undefined) return;
    this.#quitting = true;
    this.#quitCompletion = this.#options
      .stopHost()
      .catch((error: unknown) => this.#options.reportStopFailure?.(error))
      .then(() => {
        this.#quitReady = true;
        this.#options.finishQuit();
      });
  }
}

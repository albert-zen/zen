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
  cancelBootstrap?(): Promise<void>;
  stopHost(): Promise<void>;
  finishQuit(): void;
  reportStopFailure?(error: unknown): void;
}

class ZenXBootstrapCancelledError extends Error {
  constructor() {
    super("ZenX bootstrap was cancelled");
    this.name = "ZenXBootstrapCancelledError";
  }
}

/** Process-local cancellation and join fence for the one Electron bootstrap. */
export class ZenXBootstrapFence {
  #cancelled = false;
  #started = false;
  #execution: Promise<void> | undefined;

  get cancelled(): boolean {
    return this.#cancelled;
  }

  run(operation: () => Promise<void>): Promise<void> {
    if (this.#started) {
      throw new Error("ZenX bootstrap has already started");
    }
    this.#started = true;
    const execution = Promise.resolve().then(async () => {
      if (this.#cancelled) return;
      try {
        await operation();
        this.throwIfCancelled();
      } catch (error) {
        if (this.#cancelled && error instanceof ZenXBootstrapCancelledError) {
          return;
        }
        throw error;
      }
    });
    this.#execution = execution;
    return execution;
  }

  cancelAndJoin(): Promise<void> {
    this.#cancelled = true;
    return this.#execution ?? Promise.resolve();
  }

  throwIfCancelled(): void {
    if (this.#cancelled) throw new ZenXBootstrapCancelledError();
  }

  rethrowIfCancelled(error: unknown): void {
    if (this.#cancelled) throw error;
  }
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
    let bootstrapJoin: Promise<void>;
    try {
      bootstrapJoin = this.#options.cancelBootstrap?.() ?? Promise.resolve();
    } catch (error) {
      bootstrapJoin = Promise.reject(error);
    }
    this.#quitCompletion = this.#finishQuit(bootstrapJoin);
  }

  async #finishQuit(bootstrapJoin: Promise<void>): Promise<void> {
    const failures: unknown[] = [];
    try {
      await bootstrapJoin;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#options.stopHost();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      const failure =
        failures.length === 1
          ? failures[0]
          : new AggregateError(
              failures,
              "Could not fully join bootstrap and stop ZenX before quit",
            );
      try {
        this.#options.reportStopFailure?.(failure);
      } catch {
        // Failure reporting must not retain the Electron process during Quit.
      }
    }
    this.#quitReady = true;
    this.#options.finishQuit();
  }
}

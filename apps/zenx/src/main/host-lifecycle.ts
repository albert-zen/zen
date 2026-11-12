import {
  LifecycleWaitUnconfirmedError,
  waitForLifecycle,
} from "./lifecycle-wait.js";

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
  /** Reporting deadline per Quit phase, not proof of provider termination. */
  shutdownWaitMs?: number;
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
  #bootstrapJoin: Promise<void> | undefined;
  #hostStop: Promise<void> | undefined;
  #unconfirmedReported = false;

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
    if (this.#bootstrapJoin === undefined) {
      try {
        this.#bootstrapJoin =
          this.#options.cancelBootstrap?.() ?? Promise.resolve();
      } catch (error) {
        this.#bootstrapJoin = Promise.reject(error);
      }
    }
    this.#quitCompletion = this.#finishQuit();
  }

  async #finishQuit(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#joinBootstrapWithinBudget();
    } catch (error) {
      if (error instanceof LifecycleWaitUnconfirmedError) {
        this.#blockQuit(error);
        return;
      }
      failures.push(error);
    }
    try {
      this.#hostStop ??= Promise.resolve().then(() => this.#options.stopHost());
      await waitForLifecycle(
        this.#hostStop,
        "ZenX Host cleanup",
        this.#options.shutdownWaitMs ?? 5_000,
      );
    } catch (error) {
      if (error instanceof LifecycleWaitUnconfirmedError) {
        this.#blockQuit(error);
        return;
      }
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

  async #joinBootstrapWithinBudget(): Promise<void> {
    const timeoutMs = this.#options.shutdownWaitMs ?? 5_000;
    const deadline = performance.now() + timeoutMs;
    const phase = "ZenX bootstrap cancellation/join";
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new LifecycleWaitUnconfirmedError(
          phase,
          timeoutMs,
          this.#bootstrapJoin!,
        );
      }
      try {
        await waitForLifecycle(this.#bootstrapJoin!, phase, remaining);
        return;
      } catch (error) {
        if (!(error instanceof LifecycleWaitUnconfirmedError)) throw error;
        // A previous readiness observer may have failed before its source
        // actually settled. Unwrap that source during this explicit Quit,
        // without granting a fresh deadline or restarting any operation.
        this.#bootstrapJoin = error.completion.then(() => undefined);
        this.#bootstrapJoin.catch(() => undefined);
        if (performance.now() >= deadline) throw error;
      }
    }
  }

  #blockQuit(error: LifecycleWaitUnconfirmedError): void {
    // Failure reporting cannot turn unconfirmed termination into successful Quit.
    // Keep native activity and the process alive. Another deliberate Quit may
    // re-observe the same source promises; late close never quits automatically.
    if (!this.#unconfirmedReported) {
      this.#unconfirmedReported = true;
      try {
        this.#options.reportStopFailure?.(error);
      } catch {
        /* Remain blocked even if presentation failed. */
      }
    }
    this.#quitCompletion = undefined;
  }
}

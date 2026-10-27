export type DesktopSessionState = "active" | "locked" | "suspended" | "unknown";

export interface AutomationEnvironmentSnapshot {
  platform: string;
  sessionState: DesktopSessionState;
  revision: number;
  displayState: "unknown";
  lockedUse: "unsupported";
  keepAwake: "active-operation" | "inactive" | "unavailable";
}

export interface ComputerEnvironmentPort {
  snapshot(): AutomationEnvironmentSnapshot;
  acquire(signal: AbortSignal): {
    signal: AbortSignal;
    revision: number;
    release(): void;
  };
  onInvalidated(listener: () => void): () => void;
}

interface Monitor {
  getSystemIdleState(idleThreshold: number): string;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}
interface SleepBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** Host-local OS availability and current-call lifetime; never an Agent scheduler or unlock service. */
export class AutomationEnvironment implements ComputerEnvironmentPort {
  readonly #monitor: Monitor;
  readonly #blocker?: SleepBlocker;
  readonly #listeners = new Set<() => void>();
  readonly #events: Array<[string, () => void]>;
  #state: DesktopSessionState;
  #revision = 0;
  #generation = new AbortController();
  #calls = 0;
  #blockerId?: number;
  #blockerFailed = false;
  #closed = false;
  #invalidationFailed = false;

  constructor(
    readonly options: {
      platform: string;
      monitor: Monitor;
      blocker?: SleepBlocker;
    },
  ) {
    this.#monitor = options.monitor;
    this.#blocker = options.blocker;
    this.#state = this.#probe();
    this.#events = [
      ["lock-screen", () => this.#transition("locked")],
      ["unlock-screen", () => this.#transition("active", true)],
      ["suspend", () => this.#transition("suspended")],
      ["resume", () => this.#transition(this.#probe(), true)],
    ];
    for (const [event, listener] of this.#events)
      this.#monitor.on(event, listener);
  }

  snapshot(): AutomationEnvironmentSnapshot {
    if (!this.#closed && this.#probe() === "locked") this.#transition("locked");
    return {
      platform: this.options.platform,
      sessionState: this.#state,
      revision: this.#revision,
      // Idle/lock notifications do not establish whether a display has power.
      displayState: "unknown",
      lockedUse: "unsupported",
      keepAwake:
        this.#blockerFailed || !this.#blocker
          ? "unavailable"
          : this.#blockerId === undefined
            ? "inactive"
            : "active-operation",
    };
  }

  acquire(caller: AbortSignal) {
    caller.throwIfAborted();
    if (this.#closed) throw new Error("Computer environment is closed");
    if (this.#invalidationFailed)
      throw new Error(
        "Computer observation invalidation failed; restart this provider before input",
      );
    // Poll before admission to cover a missed notification; never infer unlock from a failed probe.
    const state = this.#probe();
    if (state === "locked") this.#transition("locked");
    if (this.#state === "locked" || this.#state === "suspended")
      throw new Error(
        `Computer session is ${this.#state}; unlock or resume locally, then inspect again. No input dispatched.`,
      );
    if (this.#calls++ === 0 && this.#blocker) {
      try {
        this.#blockerId = this.#blocker.start("prevent-app-suspension");
        this.#blockerFailed = false;
      } catch {
        // Wake prevention is best-effort; native session checks still determine capability.
        this.#blockerFailed = true;
      }
    }
    let released = false;
    return {
      revision: this.#revision,
      signal: AbortSignal.any([caller, this.#generation.signal]),
      release: () => {
        if (released) return;
        released = true;
        this.#calls = Math.max(0, this.#calls - 1);
        if (this.#calls === 0) this.#releaseBlocker();
      },
    };
  }

  onInvalidated(listener: () => void): () => void {
    if (this.#closed) throw new Error("Computer environment is closed");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation.abort(new Error("Computer environment closed"));
    for (const [event, listener] of this.#events)
      this.#monitor.removeListener(event, listener);
    this.#listeners.clear();
    this.#releaseBlocker();
  }

  #probe(): DesktopSessionState {
    try {
      const state = this.#monitor.getSystemIdleState(1);
      return state === "locked"
        ? "locked"
        : state === "active" || state === "idle"
          ? "active"
          : "unknown";
    } catch {
      return "unknown";
    }
  }

  #transition(state: DesktopSessionState, force = false): void {
    if (this.#closed || (!force && state === this.#state)) return;
    this.#state = state;
    this.#revision++;
    this.#generation.abort(
      new Error(
        "Desktop session changed; reobserve before input. Pending effects may be unknown.",
      ),
    );
    this.#generation = new AbortController();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        this.#invalidationFailed = true;
      }
    }
  }

  #releaseBlocker(): void {
    const id = this.#blockerId;
    this.#blockerId = undefined;
    if (id !== undefined) {
      try {
        this.#blocker?.stop(id);
      } catch {
        this.#blockerFailed = true;
      }
    }
  }
}

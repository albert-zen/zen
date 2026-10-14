import { randomUUID } from "node:crypto";
import type { ToolInvocation } from "../../../../src/tool.js";

/** Host presentation only. This does not grant foreground consent or own a Turn. */
export interface ForegroundActivityRunner {
  run<T>(
    invocation: ToolInvocation,
    operation: (signal: AbortSignal, onStopping?: () => void) => Promise<T>,
  ): Promise<T>;
}

export interface ForegroundActivitySnapshot {
  activities: readonly { id: string; agentName: string; stopping: boolean }[];
}

export interface ForegroundActivityPresenter {
  /** Resolves only after the non-activating indicator has been painted. */
  update(snapshot: ForegroundActivitySnapshot): Promise<void>;
  close(): void;
}

/** A disposable set of actual local foreground calls, never a task scheduler. */
export class ForegroundActivity implements ForegroundActivityRunner {
  readonly #presenter: ForegroundActivityPresenter;
  readonly #agentName: (invocation: ToolInvocation) => string;
  readonly #stopOwner?: (invocation: ToolInvocation) => Promise<void>;
  readonly #report: (error: unknown) => void;
  readonly #active = new Map<
    string,
    {
      invocation: ToolInvocation;
      controller: AbortController;
      agentName: string;
      signal: AbortSignal;
      stopping: boolean;
    }
  >();
  #closed = false;

  constructor(options: {
    presenter: ForegroundActivityPresenter;
    agentName(invocation: ToolInvocation): string;
    stopOwner?(invocation: ToolInvocation): Promise<void>;
    report(error: unknown): void;
  }) {
    this.#presenter = options.presenter;
    this.#agentName = options.agentName;
    this.#stopOwner = options.stopOwner;
    this.#report = options.report;
  }

  get snapshot(): ForegroundActivitySnapshot {
    return {
      activities: [...this.#active].map(([id, activity]) => ({
        id,
        agentName: activity.agentName,
        stopping: activity.stopping || activity.signal.aborted,
      })),
    };
  }

  async run<T>(
    invocation: ToolInvocation,
    operation: (signal: AbortSignal, onStopping?: () => void) => Promise<T>,
  ): Promise<T> {
    invocation.signal.throwIfAborted();
    if (this.#closed) throw new Error("Foreground indicator is closed");
    const id = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([invocation.signal, controller.signal]);
    const active = {
      invocation,
      controller,
      signal,
      agentName: this.#agentName(invocation),
      stopping: false,
    };
    this.#active.set(id, active);
    const aborted = () => this.#refresh();
    signal.addEventListener("abort", aborted, { once: true });
    try {
      // Admission, argument validation and consent precede this hook. An
      // unavailable indicator must never silently fall through to global input.
      await this.#presenter.update(this.snapshot);
      signal.throwIfAborted();
      return await operation(signal, () => {
        if (active.stopping || signal.aborted) return;
        active.stopping = true;
        this.#refresh();
      });
    } finally {
      signal.removeEventListener("abort", aborted);
      this.#active.delete(id);
      // Abort is intent. The indicator remains until the provider actually settles.
      this.#refresh();
    }
  }

  stop(ids: readonly string[]): void {
    const owners = new Map<string, ToolInvocation>();
    for (const id of ids) {
      const active = this.#active.get(id);
      if (!active || active.signal.aborted) continue;
      active.controller.abort(
        new DOMException("Foreground operation stopped by user", "AbortError"),
      );
      const key = JSON.stringify([
        active.invocation.threadId,
        active.invocation.canonicalToolCallId,
      ]);
      owners.set(key, active.invocation);
    }
    for (const invocation of owners.values()) {
      // The integration verifies the exact canonical call's Turn. It must never
      // substitute whatever Turn happens to be running when this resolves.
      void this.#stopOwner?.(invocation).catch(this.#report);
    }
  }

  unavailable(error: unknown): void {
    for (const active of this.#active.values()) {
      if (!active.signal.aborted) active.controller.abort(error);
    }
    this.#report(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of this.#active.values()) {
      active.controller.abort(
        new Error("Foreground indicator is shutting down"),
      );
    }
    this.#presenter.close();
  }

  #refresh(): void {
    if (this.#closed) return;
    void this.#presenter
      .update(this.snapshot)
      .catch((error: unknown) => this.unavailable(error));
  }
}

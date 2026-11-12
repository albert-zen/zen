import type { ChildProcess } from "node:child_process";

export type OwnedChildTerminalOutcome =
  | {
      readonly type: "close";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly type: "spawn_error";
      readonly code: null;
      readonly signal: null;
      readonly error: Error;
    };

export interface OwnedChildObservation {
  readonly terminal: Promise<OwnedChildTerminalOutcome>;
  outcome(): OwnedChildTerminalOutcome | undefined;
  lastError(): Error | undefined;
}

/**
 * Observe the terminal state of one exact owned child process.
 *
 * ChildProcess `error` is not generally terminal: Node also emits it when a
 * signal cannot be delivered to a process that was successfully spawned. The
 * only error that proves there is no process to settle is a spawn failure with
 * no PID. Every other spawned-child error remains diagnostic until `close`.
 */
export function observeOwnedChild(child: ChildProcess): OwnedChildObservation {
  let spawned = child.pid !== undefined;
  let outcome: OwnedChildTerminalOutcome | undefined;
  let lastError: Error | undefined;
  let resolveTerminal!: (value: OwnedChildTerminalOutcome) => void;
  const terminal = new Promise<OwnedChildTerminalOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  const finish = (value: OwnedChildTerminalOutcome): void => {
    if (outcome !== undefined) return;
    outcome = value;
    resolveTerminal(value);
  };
  child.once("spawn", () => {
    spawned = true;
  });
  child.on("error", (error) => {
    lastError = error;
    if (!spawned && child.pid === undefined) {
      finish({
        type: "spawn_error",
        code: null,
        signal: null,
        error,
      });
    }
  });
  child.once("close", (code, signal) => {
    finish({ type: "close", code, signal });
  });
  return {
    terminal,
    outcome: () => outcome,
    lastError: () => lastError,
  };
}

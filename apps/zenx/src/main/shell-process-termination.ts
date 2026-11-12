import type { ChildProcess } from "node:child_process";
import {
  realWindowsProcessOperations,
  type WindowsProcessIdentity,
  type WindowsProcessOperations,
  type WindowsProcessTableSnapshot,
} from "./trigger-program-runner.js";

interface TerminationResult {
  ok: boolean;
  error: string;
}

export interface WindowsShellProcessController {
  /** Join launch observation even when the command itself completes quickly. */
  readonly ready: Promise<void>;
  terminate(): Promise<TerminationResult>;
}

const MAX_PASSES = 32;
const MAX_OPERATIONS = 64;
const MAX_TRACKED_PROCESSES = 128;
/**
 * Caller join / dispatch-deadline policy, not a guaranteed helper settlement
 * maximum. A caller reaching this deadline must report cleanup as unconfirmed.
 */
export const WINDOWS_SHELL_SHUTDOWN_WAIT_MS = 30_000;

/**
 * Snapshot ownership for one actual Shell child, without a process registry.
 * This is not a Job Object: ancestry that appears and vanishes between snapshots
 * cannot be recovered. Success verifies the captured identities, not arbitrary
 * escaped descendants. Newly observed ambiguous ancestry fails closed.
 *
 * Each real operation owns and settles its helper. Its timeout requests cleanup
 * but does not bound helper settlement. Do not race a helper against another
 * timer: a detached termination could otherwise run after this controller
 * reported failure. This budget prevents dispatching additional work; it is not
 * a guaranteed wall-clock bound for an already in-flight helper.
 */
export function createWindowsShellTerminator(
  operations: WindowsProcessOperations,
  options: { now?: () => number } = {},
): (child: ChildProcess) => WindowsShellProcessController {
  const now = options.now ?? (() => performance.now());
  return (child) => {
    const tracked = new Map<number, WindowsProcessIdentity>();
    const pid = child.pid;
    let exited = child.exitCode !== null || child.signalCode !== null;
    const onExit = () => {
      exited = true;
    };
    child.once("exit", onExit);
    // Start immediately at launch, before a later Stop loses the root identity.
    const ownership = (async (): Promise<TerminationResult> => {
      try {
        if (
          pid === undefined ||
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          exited ||
          child.killed
        )
          return failure("the owned foreground process is not live at capture");
        const table = await operations.captureProcessTable();
        if (
          exited ||
          child.exitCode !== null ||
          child.signalCode !== null ||
          child.killed ||
          child.pid !== pid
        )
          return failure("the owned foreground exited during identity capture");
        const root = table.entries.find((entry) => entry.pid === pid);
        if (root === undefined || root.parentPid !== process.pid)
          return failure("the owned foreground identity was absent or changed");
        if (!hasCreationTime(root))
          return failure("the owned foreground creation time is unknown");
        tracked.set(pid, { ...root });
        return expandOwnedDescendants(tracked, table);
      } catch (error) {
        return failure(`initial process observation failed: ${String(error)}`);
      } finally {
        child.removeListener("exit", onExit);
      }
    })();
    let termination: Promise<TerminationResult> | undefined;
    return {
      ready: ownership.then(() => undefined),
      terminate: () => (termination ??= terminate()),
    };

    async function terminate(): Promise<TerminationResult> {
      // A Stop received during launch discovery gets the same overall budget,
      // rather than a fresh 30 seconds after that discovery finishes.
      const deadline = now() + WINDOWS_SHELL_SHUTDOWN_WAIT_MS;
      const initial = await ownership;
      if (!initial.ok) return initial;
      let usedOperations = 0;
      let absentPasses = 0;
      try {
        for (let pass = 0; pass < MAX_PASSES; pass += 1) {
          if (now() >= deadline || usedOperations >= MAX_OPERATIONS)
            return failure("the bounded termination budget was exhausted");
          usedOperations += 1;
          const table = await operations.captureProcessTable();
          if (now() >= deadline)
            return failure("the bounded process-observation budget expired");
          const expanded = expandOwnedDescendants(tracked, table);
          if (!expanded.ok) return expanded;
          const current = new Map(
            table.entries.map((entry) => [entry.pid, entry]),
          );
          const live = [...tracked.values()].filter((identity) =>
            matches(identity, current.get(identity.pid)),
          );
          if (live.length === 0) {
            absentPasses += 1;
            // Independent observations, never a successful kill return alone.
            if (absentPasses >= 2) return { ok: true, error: "" };
            continue;
          }
          absentPasses = 0;
          if (usedOperations >= MAX_OPERATIONS)
            return failure(
              "the bounded termination operation budget was exhausted",
            );
          // Descendants are inserted after parents. Kill one leaf, then observe
          // again before killing its parent, capturing newly born children first.
          const identity = live.at(-1)!;
          usedOperations += 1;
          const result = await operations.terminateProcessIdentity(identity);
          if (!result.ok && result.error !== "process was not found")
            return failure(`PID ${String(identity.pid)}: ${result.error}`);
        }
        return failure("the bounded process-observation passes were exhausted");
      } catch (error) {
        return failure(
          `process observation or termination failed: ${String(error)}`,
        );
      }
    }
  };
}

function expandOwnedDescendants(
  tracked: Map<number, WindowsProcessIdentity>,
  table: WindowsProcessTableSnapshot,
): TerminationResult {
  const current = new Map<number, WindowsProcessIdentity>();
  for (const entry of table.entries) {
    if (current.has(entry.pid))
      return failure("the process snapshot contains duplicate identities");
    current.set(entry.pid, entry);
  }
  for (const identity of tracked.values()) {
    const actual = current.get(identity.pid);
    if (actual !== undefined && !matches(identity, actual))
      return failure(
        `tracked PID ${String(identity.pid)} has a changed or unknown identity`,
      );
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table.entries) {
      if (tracked.has(entry.pid)) continue;
      const parent = tracked.get(entry.parentPid);
      if (parent === undefined) continue;
      if (!hasCreationTime(entry))
        return failure(`PID ${String(entry.pid)} has an unknown creation time`);
      // An older orphan with a recycled PPID is provably not this parent's child.
      if (BigInt(entry.startTime) < BigInt(parent.startTime!)) continue;
      if (!matches(parent, current.get(parent.pid)))
        return failure(
          `PID ${String(entry.pid)} has ambiguous ancestry under absent or reused parent PID ${String(parent.pid)}`,
        );
      if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0)
        return failure("a descendant has an invalid process identity");
      if (tracked.size >= MAX_TRACKED_PROCESSES)
        return failure("the bounded tracked-process limit was exhausted");
      tracked.set(entry.pid, { ...entry });
      changed = true;
    }
  }
  return { ok: true, error: "" };
}

function hasCreationTime(
  identity: WindowsProcessIdentity,
): identity is WindowsProcessIdentity & { startTime: string } {
  return identity.startTime !== null && /^\d+$/u.test(identity.startTime);
}

function matches(
  expected: WindowsProcessIdentity,
  actual: WindowsProcessIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    hasCreationTime(actual) &&
    actual.startTime === expected.startTime
  );
}

function failure(detail: string): TerminationResult {
  return {
    ok: false,
    error: `Windows Shell cancellation is unconfirmed: ${detail}. Snapshot ownership cannot prove escaped or vanished ancestry.`,
  };
}

export const trackWindowsShellProcess = createWindowsShellTerminator(
  realWindowsProcessOperations,
);

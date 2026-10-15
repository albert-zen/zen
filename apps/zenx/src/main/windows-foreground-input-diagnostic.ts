import { mkdir, open, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// This file is only read from the exact mkdtemp directory owned by this probe.
export const GUARD_STAGE_FILE = "startup-stages.jsonl";
const MAX_STAGE_BYTES = 16_384;
const MAX_RECORDS = 64;
const GUARD_PHASES = new Set([
  "script-entry",
  "assemblies-loaded",
  "compile-start",
  "compiled",
  "managed-entry",
  "dpi-ready",
  "form-constructed",
  "form-shown",
  "activation-finished",
  "message-loop-enter",
  "first-tick",
  "foreground-confirmed",
  "self-click-injected",
  "self-click-received",
  "ready-written",
  "close-observed",
  "form-closed",
  "form-cleanup-complete",
  "managed-return",
  "script-return",
  "guard-error",
]);
type ParentPhase =
  | "probe-start"
  | "spawn-returned"
  | "spawned"
  | "spawn-error"
  | "child-error"
  | "report-observed"
  | "report-validated"
  | "report-timeout"
  | "close-requested"
  | "close-written"
  | "close-write-failed"
  | "kill-requested"
  | "kill-returned"
  | "kill-threw"
  | "child-exit"
  | "child-close";
export type GuardReportFile =
  | "ready.json"
  | "edge.json"
  | "stop-result.json"
  | "escape-result.json"
  | "final.json";
type Stage = { phase: string; pid: number; elapsedMs: number };
type ParentStage = Stage & { report?: GuardReportFile };

/** Never includes raw input lines or extra fields, even for malformed receipts. */
export function projectGuardStages(text: string, childPid: number | undefined) {
  const stages: Stage[] = [];
  const seen = new Set<string>();
  let rejectedRecords = 0;
  let lastElapsed = -1;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object") throw new Error();
      const { phase, pid, elapsedMs } = value as Stage;
      if (
        !Number.isSafeInteger(childPid) ||
        childPid! <= 0 ||
        pid !== childPid ||
        !GUARD_PHASES.has(phase) ||
        seen.has(phase) ||
        !Number.isSafeInteger(elapsedMs) ||
        elapsedMs < 0 ||
        elapsedMs < lastElapsed ||
        stages.length >= MAX_RECORDS
      )
        throw new Error();
      stages.push({ phase, pid, elapsedMs });
      seen.add(phase);
      lastElapsed = elapsedMs;
    } catch {
      rejectedRecords++;
    }
  }
  return { stages, rejectedRecords };
}

async function readGuardStages(
  directory: string,
  childPid: number | undefined,
) {
  try {
    const handle = await open(join(directory, GUARD_STAGE_FILE), "r");
    try {
      // Read a fixed byte budget even if a live helper is still appending.
      const bytes = Buffer.alloc(MAX_STAGE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_STAGE_BYTES)
        return { status: "oversized", stages: [], rejectedRecords: 0 };
      return {
        status: "read",
        ...projectGuardStages(
          bytes.subarray(0, bytesRead).toString(),
          childPid,
        ),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "unavailable", stages: [], rejectedRecords: 0 };
  }
}

export function createWindowsGuardDiagnostic(directory: string) {
  const startedAt = performance.now();
  const parentStages: ParentStage[] = [];
  let droppedRecords = 0;
  const mark = (phase: ParentPhase, report?: GuardReportFile) => {
    if (parentStages.length >= MAX_RECORDS) {
      droppedRecords++;
      return;
    }
    parentStages.push({
      phase,
      pid: process.pid,
      elapsedMs: Math.floor(performance.now() - startedAt),
      ...(report === undefined ? {} : { report }),
    });
  };
  mark("probe-start");
  return {
    mark,
    async retainFailure(
      outputDirectory: string | undefined,
      terminal: {
        childPid: number | undefined;
        closed: boolean;
        forced: boolean;
        killAccepted: boolean | null;
        exitCode: number | null;
        exitSignal: NodeJS.Signals | null;
        spawnError: boolean;
        childError: boolean;
        stderrBytes: number;
      },
    ) {
      // Failure-only diagnostics are best effort and must not mask the cause.
      try {
        const snapshot = {
          kind: "windows-native-guard-startup",
          version: 1,
          parentPid: process.pid,
          guardPid: terminal.childPid ?? null,
          parentClock: "milliseconds-since-probe-start",
          guardClock: "milliseconds-since-script-entry",
          parentStages: [...parentStages],
          droppedRecords,
          guardStages: await readGuardStages(directory, terminal.childPid),
          directChildClosed: terminal.closed,
          descendantCleanup: "not-observed",
          forcedTerminationRequested: terminal.forced,
          killAccepted: terminal.killAccepted,
          exitCode: terminal.exitCode,
          exitSignal:
            terminal.exitSignal === null ||
            terminal.exitSignal === "SIGTERM" ||
            terminal.exitSignal === "SIGKILL"
              ? terminal.exitSignal
              : "other",
          spawnError: terminal.spawnError,
          childError: terminal.childError,
          stderrBytes: terminal.stderrBytes,
        };
        const json = JSON.stringify(snapshot);
        console.error("Windows native guard diagnostic", json);
        if (outputDirectory) {
          await mkdir(outputDirectory, { recursive: true });
          await writeFile(
            join(outputDirectory, `${basename(directory)}.json`),
            json,
          );
        }
      } catch {
        // No raw error/path is added to the public diagnostic artifact.
        try {
          console.error(
            "Windows native guard diagnostic could not be retained",
          );
        } catch {
          // Even a broken diagnostic log sink cannot replace the guard failure.
        }
      }
    },
  };
}

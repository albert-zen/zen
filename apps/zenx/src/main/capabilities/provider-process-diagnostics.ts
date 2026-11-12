import path from "node:path";
import { localErrorDetail } from "../../local-error-detail.js";
import { BoundedLocalDiagnosticLog } from "../bounded-diagnostic-log.js";

export interface ProviderProcessFailure {
  executable: string;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  failure?: unknown;
}
export type ProviderProcessDiagnosticReporter = (
  failure: ProviderProcessFailure,
) => Promise<void>;

/** Existing owner-local diagnostics channel; never a model/tool result or export. */
export function createProviderProcessDiagnosticReporter(
  userDataDirectory: string,
): ProviderProcessDiagnosticReporter {
  const log = new BoundedLocalDiagnosticLog({
    userDataDirectory,
    fileName: "provider-process.jsonl",
    maxBytes: 1024 * 1024,
    normalize: (input) => {
      if (!input || typeof input !== "object") return null;
      const value = input as Record<string, unknown>;
      return typeof value.timestamp === "string" &&
        typeof value.executable === "string" &&
        typeof value.detail === "string"
        ? {
            timestamp: value.timestamp,
            executable: value.executable,
            detail: value.detail,
          }
        : null;
    },
  });
  return async (failure) => {
    try {
      await log.record({
        timestamp: new Date().toISOString(),
        executable: path.basename(failure.executable),
        detail: localErrorDetail({
          code: failure.code,
          signal: failure.signal,
          stderr: failure.stderr,
          stdout: failure.stdout,
          cause: failure.failure,
        }),
      });
    } catch {
      /* Diagnostics cannot change process settlement or its launch lease. */
    }
  };
}

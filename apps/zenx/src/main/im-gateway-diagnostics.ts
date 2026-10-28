import { localErrorDetail } from "../local-error-detail.js";
import { BoundedLocalDiagnosticLog } from "./bounded-diagnostic-log.js";

/** Same owner-only diagnostics directory as Settings; never adds data to tool status. */
export function createImGatewayDiagnosticSink(userDataDirectory: string) {
  const log = new BoundedLocalDiagnosticLog<{
    timestamp: string;
    stage: "startup" | "exit";
    detail: string;
    stderr: string;
  }>({
    userDataDirectory,
    fileName: "im-gateway.jsonl",
    maxBytes: 1024 * 1024,
    normalize(input) {
      const event = input as {
        stage?: unknown;
        error?: unknown;
        stderr?: unknown;
      };
      if (event?.stage !== "startup" && event?.stage !== "exit") return null;
      return {
        timestamp: new Date().toISOString(),
        stage: event.stage,
        detail: localErrorDetail(event.error),
        stderr:
          typeof event.stderr === "string" ? event.stderr.slice(-65_600) : "",
      };
    },
  });
  return async (event: {
    stage: "startup" | "exit";
    error: unknown;
    stderr: string;
  }) => {
    if (!(await log.record(event)))
      throw new Error("IM Gateway local diagnostic record could not be stored");
  };
}

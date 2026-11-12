import type { BrowserWindow } from "electron";
import type {
  MainWindowEvent,
  OperationalDiagnosticLog,
} from "./operational-diagnostic-log.js";

/** Observe only the app's top-level window; failures must not change its lifecycle. */
export function attachMainWindowDiagnostics(
  window: BrowserWindow,
  diagnostics: Pick<OperationalDiagnosticLog, "recordMainWindowEvent">,
  isQuitting: () => boolean,
): void {
  const web = window.webContents;
  let closed = false;
  let unresponsive = false;
  const report = (event: MainWindowEvent) => {
    if (closed || isQuitting()) return;
    try {
      void Promise.resolve(
        diagnostics.recordMainWindowEvent({
          ...event,
          windowId: window.id,
          mainPid: process.pid,
        }),
      ).catch(() => undefined);
    } catch {
      // Diagnostic storage is best effort, including synchronous failures.
    }
  };
  const gone = (
    _event: unknown,
    details: { reason: string; exitCode: number },
  ) => {
    unresponsive = false;
    if (details.reason === "clean-exit") return; // Normal renderer teardown is not a crash.
    report({
      event: "main-window",
      status: "renderer-gone",
      reason: details.reason,
      exitCode: details.exitCode,
    });
  };
  const stalled = () => {
    if (unresponsive) return;
    unresponsive = true;
    report({ event: "main-window", status: "unresponsive" });
  };
  const resumed = () => {
    if (!unresponsive) return;
    unresponsive = false;
    report({ event: "main-window", status: "responsive" });
  };
  const failed = (
    _event: unknown,
    errorCode: number,
    _description: string,
    _url: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || errorCode === -3) return;
    report({ event: "main-window", status: "load-failed", errorCode });
  };
  web.on("render-process-gone", gone);
  web.on("unresponsive", stalled);
  web.on("responsive", resumed);
  web.on("did-fail-load", failed);
  window.once("closed", () => {
    closed = true;
    web.removeListener("render-process-gone", gone);
    web.removeListener("unresponsive", stalled);
    web.removeListener("responsive", resumed);
    web.removeListener("did-fail-load", failed);
  });
}

import { localErrorDetail } from "../local-error-detail.js";
import { BoundedLocalDiagnosticLog } from "./bounded-diagnostic-log.js";
import type { AppServerHostStatus } from "./app-server-manager.js";
import type { ZenXComputerReadinessSnapshot } from "./computer-readiness.js";
import type { ZenXPluginDiagnostics } from "./capabilities/types.js";

type AppServerCode =
  "starting" | "ready" | "reconnected" | "reconnecting" | "error" | "stopped";
type ComputerAccessCode = ZenXComputerReadinessSnapshot["accessibility"];
type ScreenRecordingCode = ZenXComputerReadinessSnapshot["screenRecording"];
type ComputerProbeCode =
  | "not-checked"
  | "ready"
  | "needs-setup"
  | "failed"
  | "unknown"
  | "not-applicable";
type PluginCapabilityCode = "browser" | "computer" | "other";
type PluginFailureCode =
  | "discovery-error"
  | "plugin-startup-failed"
  | "provider-unavailable"
  | "provider-fallback"
  | "provider-integrity-failed";

export type MainWindowEvent =
  | {
      event: "main-window";
      status: "renderer-gone";
      reason: string;
      exitCode?: number;
      windowId?: number;
      mainPid?: number;
    }
  | {
      event: "main-window";
      status: "load-failed";
      errorCode: number;
      windowId?: number;
      mainPid?: number;
    }
  | {
      event: "main-window";
      status: "unresponsive" | "responsive";
      windowId?: number;
      mainPid?: number;
    };

type OperationalEvent = (
  | MainWindowEvent
  | { event: "desktop-bootstrap"; status: "failed" }
  | { event: "app-server"; status: AppServerCode }
  | {
      event: "computer-readiness";
      status: ScreenRecordingCode;
      accessibility: ComputerAccessCode;
      accessibilityProbe: ComputerProbeCode;
      screenCaptureProbe: ComputerProbeCode;
    }
  | {
      event: "plugin";
      reason: PluginFailureCode;
      capability: PluginCapabilityCode;
    }
) & { detail?: string };

type OperationalRecord = OperationalEvent & { timestamp: string };

const rendererExitReasons = new Set([
  "clean-exit",
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
  "memory-eviction",
]);
const mainWindowStatuses = new Set(["unresponsive", "responsive"]);
function boundedNumber(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

const appServerCodes = new Set<AppServerCode>([
  "starting",
  "ready",
  "reconnected",
  "reconnecting",
  "error",
  "stopped",
]);
const computerAccessCodes = new Set<ComputerAccessCode>([
  "granted",
  "needs-setup",
  "unknown",
  "not-applicable",
]);
const screenRecordingCodes = new Set<ScreenRecordingCode>([
  "granted",
  "denied",
  "restricted",
  "not-determined",
  "unknown",
  "not-applicable",
]);
const probeCodes = new Set<ComputerProbeCode>([
  "not-checked",
  "ready",
  "needs-setup",
  "failed",
  "unknown",
  "not-applicable",
]);
const pluginCapabilities = new Set<PluginCapabilityCode>([
  "browser",
  "computer",
  "other",
]);
const pluginFailures = new Set<PluginFailureCode>([
  "discovery-error",
  "plugin-startup-failed",
  "provider-unavailable",
  "provider-fallback",
  "provider-integrity-failed",
]);

/** Owner-local bounded detail, not a complete raw Trace or an export. */
function diagnosticDetail(reason: unknown): string {
  const value = localErrorDetail(reason);
  return value.length <= 16_384
    ? value
    : value.slice(0, 16_384) + "\n[operational diagnostic detail truncated]";
}

/** Project fixed operational codes plus explicit owner-local diagnostic detail. */
export function normalizeOperationalDiagnostic(
  input: unknown,
  now = new Date(),
): OperationalRecord | null {
  if (input === null || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const timestamp = now.toISOString();
  const detail =
    typeof value.detail === "string"
      ? { detail: diagnosticDetail(value.detail) }
      : {};
  if (value.event === "main-window") {
    const identity = {
      ...(boundedNumber(value.windowId, 1, 10_000_000) === undefined
        ? {}
        : { windowId: value.windowId as number }),
      ...(boundedNumber(value.mainPid, 1, 10_000_000) === undefined
        ? {}
        : { mainPid: value.mainPid as number }),
    };
    if (value.status === "renderer-gone") {
      const reason = rendererExitReasons.has(value.reason as string)
        ? (value.reason as string)
        : "other";
      const exitCode = boundedNumber(value.exitCode, -65_535, 65_535);
      return {
        timestamp,
        event: "main-window",
        status: "renderer-gone",
        reason,
        ...identity,
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    if (value.status === "load-failed") {
      const errorCode = boundedNumber(value.errorCode, -65_535, 65_535);
      if (errorCode === undefined || errorCode === -3) return null; // ERR_ABORTED is normal navigation.
      return {
        timestamp,
        event: "main-window",
        status: "load-failed",
        errorCode,
        ...identity,
      };
    }
    if (mainWindowStatuses.has(value.status as string))
      return {
        timestamp,
        event: "main-window",
        status: value.status as "unresponsive" | "responsive",
        ...identity,
      };
    return null;
  }
  if (value.event === "desktop-bootstrap") {
    if (value.status !== "failed") return null;
    return {
      timestamp,
      event: "desktop-bootstrap",
      status: "failed",
      ...detail,
    };
  }
  if (value.event === "app-server") {
    if (!appServerCodes.has(value.status as AppServerCode)) return null;
    return {
      timestamp,
      event: "app-server",
      status: value.status as AppServerCode,
      ...detail,
    };
  }
  if (value.event === "computer-readiness") {
    if (
      !screenRecordingCodes.has(value.status as ScreenRecordingCode) ||
      !computerAccessCodes.has(value.accessibility as ComputerAccessCode) ||
      !probeCodes.has(value.accessibilityProbe as ComputerProbeCode) ||
      !probeCodes.has(value.screenCaptureProbe as ComputerProbeCode)
    )
      return null;
    return {
      timestamp,
      event: "computer-readiness",
      status: value.status as ScreenRecordingCode,
      accessibility: value.accessibility as ComputerAccessCode,
      accessibilityProbe: value.accessibilityProbe as ComputerProbeCode,
      screenCaptureProbe: value.screenCaptureProbe as ComputerProbeCode,
    };
  }
  if (value.event === "plugin") {
    if (
      !pluginFailures.has(value.reason as PluginFailureCode) ||
      !pluginCapabilities.has(value.capability as PluginCapabilityCode)
    )
      return null;
    return {
      timestamp,
      event: "plugin",
      reason: value.reason as PluginFailureCode,
      capability: value.capability as PluginCapabilityCode,
      ...detail,
    };
  }
  return null;
}

function computerEvent(
  snapshot: ZenXComputerReadinessSnapshot,
): Extract<OperationalEvent, { event: "computer-readiness" }> {
  return {
    event: "computer-readiness",
    status: snapshot.screenRecording,
    accessibility: snapshot.accessibility,
    accessibilityProbe:
      snapshot.verification?.accessibility.state ?? "not-checked",
    screenCaptureProbe:
      snapshot.verification?.screenCapture.state ?? "not-checked",
  };
}

function appServerCode(status: AppServerHostStatus): AppServerCode {
  return status.type === "ready" && status.reconnected
    ? "reconnected"
    : status.type;
}

function pluginCapabilityCode(value: string): PluginCapabilityCode {
  return value === "browser" || value === "computer" ? value : "other";
}

/** Best-effort support observations. No operation depends on diagnostic I/O. */
export class OperationalDiagnosticLog {
  readonly #sink: BoundedLocalDiagnosticLog<OperationalRecord>;
  #lastAppServer?: string;
  #lastComputer?: string;
  #discoveryErrorCount = 0;
  #bundledStartupFailureCount = 0;
  #providerFailures = new Map<string, string>();
  #pendingObservation: Promise<void> = Promise.resolve();

  constructor(userDataDirectory: string, options: { maxBytes?: number } = {}) {
    this.#sink = new BoundedLocalDiagnosticLog({
      userDataDirectory,
      fileName: "operations.jsonl",
      normalize: normalizeOperationalDiagnostic,
      maxBytes: options.maxBytes,
    });
  }

  observeAppServer(status: AppServerHostStatus): Promise<void> {
    return this.#enqueue(async () => {
      const code = appServerCode(status);
      const detail =
        status.type === "error"
          ? diagnosticDetail(status.detail ?? status.message)
          : undefined;
      const signature = JSON.stringify([code, detail]);
      if (signature === this.#lastAppServer) return;
      if (
        await this.#append({
          event: "app-server",
          status: code,
          ...(detail === undefined ? {} : { detail }),
        })
      )
        this.#lastAppServer = signature;
    });
  }

  recordMainWindowEvent(event: MainWindowEvent): Promise<void> {
    return this.#enqueue(async () => {
      await this.#append(event);
    });
  }

  recordBootstrapFailure(error?: unknown): Promise<void> {
    return this.#enqueue(async () => {
      await this.#append({
        event: "desktop-bootstrap",
        status: "failed",
        ...(error === undefined ? {} : { detail: diagnosticDetail(error) }),
      });
    });
  }

  observeComputer(snapshot: ZenXComputerReadinessSnapshot): Promise<void> {
    return this.#enqueue(async () => {
      const event = computerEvent(snapshot);
      const signature = [
        event.status,
        event.accessibility,
        event.accessibilityProbe,
        event.screenCaptureProbe,
      ].join(":");
      if (signature === this.#lastComputer) return;
      if (await this.#append(event)) this.#lastComputer = signature;
    });
  }

  observePlugins(diagnostics: ZenXPluginDiagnostics): Promise<void> {
    return this.#enqueue(async () => {
      const startupCount = diagnostics.bundledStartupFailureCount;
      const errorCount = Math.max(
        0,
        diagnostics.discoveryErrors.length - startupCount,
      );
      if (errorCount < this.#discoveryErrorCount) this.#discoveryErrorCount = 0;
      if (
        errorCount > this.#discoveryErrorCount &&
        (await this.#append({
          event: "plugin",
          reason: "discovery-error",
          capability: "other",
          detail: diagnosticDetail({
            discoveryErrorsSnapshot: diagnostics.discoveryErrors,
          }),
        }))
      )
        this.#discoveryErrorCount = errorCount;

      if (startupCount < this.#bundledStartupFailureCount)
        this.#bundledStartupFailureCount = 0;
      if (
        startupCount > this.#bundledStartupFailureCount &&
        (await this.#append({
          event: "plugin",
          reason: "plugin-startup-failed",
          capability: "other",
          detail: diagnosticDetail({
            discoveryErrorsSnapshot: diagnostics.discoveryErrors,
          }),
        }))
      )
        this.#bundledStartupFailureCount = startupCount;

      const current = new Map<string, string>();
      for (const diagnostic of diagnostics.providerDiagnostics) {
        const key = `${diagnostic.capabilityId}\0${diagnostic.providerId}`;
        const reason: PluginFailureCode | "healthy" =
          diagnostic.integrity === "failed"
            ? "provider-integrity-failed"
            : diagnostic.status === "unavailable"
              ? "provider-unavailable"
              : diagnostic.status === "fallback"
                ? "provider-fallback"
                : "healthy";
        const detail =
          diagnostic.reason === undefined
            ? undefined
            : diagnosticDetail(diagnostic.reason);
        const signature = JSON.stringify([reason, detail]);
        const previous = this.#providerFailures.get(key);
        if (reason === "healthy" || previous === signature) {
          current.set(key, signature);
          continue;
        }
        if (
          await this.#append({
            event: "plugin",
            reason,
            capability: pluginCapabilityCode(diagnostic.capabilityId),
            ...(detail === undefined ? {} : { detail }),
          })
        )
          current.set(key, signature);
        else if (previous !== undefined) current.set(key, previous);
      }
      this.#providerFailures = current;
    });
  }

  recordPluginStartupFailure(error?: unknown): Promise<void> {
    return this.#enqueue(async () => {
      await this.#append({
        event: "plugin",
        reason: "plugin-startup-failed",
        capability: "other",
        ...(error === undefined ? {} : { detail: diagnosticDetail(error) }),
      });
    });
  }

  #enqueue(observe: () => Promise<void>): Promise<void> {
    const operation = this.#pendingObservation.then(observe);
    this.#pendingObservation = operation.catch(() => undefined);
    return this.#pendingObservation;
  }

  async #append(event: OperationalEvent): Promise<boolean> {
    try {
      return await this.#sink.record(event);
    } catch {
      // Support logging must never change a product operation's outcome.
      return false;
    }
  }
}

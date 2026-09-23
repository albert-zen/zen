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

type OperationalEvent =
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
    };

type OperationalRecord = OperationalEvent & { timestamp: string };

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

/** Strictly project fixed operational codes; never persist arbitrary source fields. */
export function normalizeOperationalDiagnostic(
  input: unknown,
  now = new Date(),
): OperationalRecord | null {
  if (input === null || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const timestamp = now.toISOString();
  if (value.event === "app-server") {
    if (!appServerCodes.has(value.status as AppServerCode)) return null;
    return {
      timestamp,
      event: "app-server",
      status: value.status as AppServerCode,
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
  #lastAppServer?: AppServerCode;
  #lastComputer?: string;
  #discoveryErrorCount = 0;
  #providerFailures = new Map<string, PluginFailureCode | "healthy">();
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
      if (code === this.#lastAppServer) return;
      if (await this.#append({ event: "app-server", status: code }))
        this.#lastAppServer = code;
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
      const errorCount = diagnostics.discoveryErrors.length;
      if (errorCount < this.#discoveryErrorCount) this.#discoveryErrorCount = 0;
      if (
        errorCount > this.#discoveryErrorCount &&
        (await this.#append({
          event: "plugin",
          reason: "discovery-error",
          capability: "other",
        }))
      )
        this.#discoveryErrorCount = errorCount;

      const current = new Map<string, PluginFailureCode | "healthy">();
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
        const previous = this.#providerFailures.get(key);
        if (reason === "healthy" || previous === reason) {
          current.set(key, reason);
          continue;
        }
        if (
          await this.#append({
            event: "plugin",
            reason,
            capability: pluginCapabilityCode(diagnostic.capabilityId),
          })
        )
          current.set(key, reason);
        else if (previous !== undefined) current.set(key, previous);
      }
      this.#providerFailures = current;
    });
  }

  recordPluginStartupFailure(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#append({
        event: "plugin",
        reason: "plugin-startup-failed",
        capability: "other",
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

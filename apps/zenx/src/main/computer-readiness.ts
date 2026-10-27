import type { AutomationEnvironmentSnapshot } from "./automation-environment.js";

export interface ZenXComputerAccessCheck {
  state: "ready" | "needs-setup" | "failed" | "unknown" | "not-applicable";
  detail?: string;
}

export interface ZenXComputerAccessVerification {
  accessibility: ZenXComputerAccessCheck;
  screenCapture: ZenXComputerAccessCheck;
}

/** A Host-owned preview of platform state and the latest scoped capability check. */
export interface ZenXComputerReadinessSnapshot {
  platform: NodeJS.Platform;
  accessibility: "granted" | "needs-setup" | "unknown" | "not-applicable";
  screenRecording:
    | "granted"
    | "denied"
    | "restricted"
    | "not-determined"
    | "unknown"
    | "not-applicable";
  foregroundControlEnabled: boolean;
  environment?: AutomationEnvironmentSnapshot;
  verification?: ZenXComputerAccessVerification;
}

export function computerReadinessSnapshot(input: {
  platform: NodeJS.Platform;
  accessibilityTrusted?: boolean;
  screenRecording?: string;
  foregroundControlEnabled: boolean;
}): ZenXComputerReadinessSnapshot {
  if (input.platform !== "darwin") {
    return {
      platform: input.platform,
      accessibility: "not-applicable",
      screenRecording: "not-applicable",
      foregroundControlEnabled: input.foregroundControlEnabled,
    };
  }
  return {
    platform: input.platform,
    accessibility:
      input.accessibilityTrusted === undefined
        ? "unknown"
        : input.accessibilityTrusted
          ? "granted"
          : "needs-setup",
    screenRecording:
      input.screenRecording === "granted" ||
      input.screenRecording === "denied" ||
      input.screenRecording === "restricted" ||
      input.screenRecording === "not-determined"
        ? input.screenRecording
        : "unknown",
    foregroundControlEnabled: input.foregroundControlEnabled,
  };
}

/** Publish read-only verification only for the exact desktop generation it actually checked. */
export async function probeCurrentComputerAccess(
  read: () => Promise<ZenXComputerReadinessSnapshot>,
  checks: Parameters<typeof probeComputerAccess>[1],
): Promise<ZenXComputerReadinessSnapshot> {
  const initial = await read();
  const verification = await probeComputerAccess(initial, checks);
  const { verification: _previous, ...current } = await read();
  const sameEnvironment =
    initial.platform === current.platform &&
    initial.accessibility === current.accessibility &&
    initial.screenRecording === current.screenRecording &&
    initial.environment?.revision === current.environment?.revision &&
    initial.environment?.sessionState === current.environment?.sessionState;
  return sameEnvironment ? { ...current, verification } : current;
}

/** Check actual read-only capability paths without returning window or pixel data. */
export async function probeComputerAccess(
  snapshot: ZenXComputerReadinessSnapshot,
  checks: {
    accessibility(): Promise<void>;
    screenCapture(): Promise<void>;
    screenRecordingStatus(): string | undefined;
  },
): Promise<ZenXComputerAccessVerification> {
  if (snapshot.platform !== "darwin") {
    return {
      accessibility: { state: "not-applicable" },
      screenCapture: { state: "not-applicable" },
    };
  }

  let accessibility: ZenXComputerAccessCheck;
  try {
    await checks.accessibility();
    accessibility = { state: "ready" };
  } catch (error) {
    const detail = boundedCheckError(error);
    accessibility =
      snapshot.accessibility === "needs-setup" ||
      /Accessibility denied for helper/iu.test(detail)
        ? { state: "needs-setup" }
        : { state: "failed", detail };
  }

  let screenCapture: ZenXComputerAccessCheck;
  if (
    snapshot.screenRecording === "denied" ||
    snapshot.screenRecording === "restricted"
  ) {
    screenCapture = { state: "needs-setup" };
  } else if (
    snapshot.environment &&
    snapshot.environment.sessionState !== "active"
  ) {
    screenCapture = {
      state: "unknown",
      detail:
        "Window capture requires an active desktop session; unlock or resume and check again",
    };
  } else {
    try {
      await checks.screenCapture();
      let currentStatus: string | undefined;
      try {
        currentStatus = checks.screenRecordingStatus();
      } catch {
        // A preview alone cannot prove that TCC granted target capture.
      }
      screenCapture =
        currentStatus === "granted"
          ? { state: "ready" }
          : currentStatus === "denied" || currentStatus === "restricted"
            ? { state: "needs-setup" }
            : { state: "unknown" };
    } catch (error) {
      let currentStatus: string | undefined;
      try {
        currentStatus = checks.screenRecordingStatus();
      } catch {
        // A failed status read is not proof of permission denial.
      }
      screenCapture =
        currentStatus === "denied" || currentStatus === "restricted"
          ? { state: "needs-setup" }
          : { state: "failed", detail: boundedCheckError(error) };
    }
  }
  return { accessibility, screenCapture };
}

function boundedCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const printable = message.replace(/[\x00-\x1f\x7f]/gu, " ").trim();
  return printable.slice(0, 200) || "Access check failed";
}

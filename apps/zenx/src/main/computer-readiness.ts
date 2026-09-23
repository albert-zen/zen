/** A Host-owned preview of platform state, not a promise that a tool call will succeed. */
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

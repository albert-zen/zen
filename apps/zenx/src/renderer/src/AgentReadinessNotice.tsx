import { useEffect, useState } from "react";

import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { ChromeBridgeSettingsSnapshot } from "../../main/chrome-extension-bridge.js";
import type { ZenXComputerReadinessSnapshot } from "../../main/computer-readiness.js";

type Readiness<T> =
  { kind: "loading" } | { kind: "ready"; value: T } | { kind: "unavailable" };

export function AgentReadinessNotice({
  pluginSnapshot,
  onOpenPlugins,
  onOpenGeneral,
}: {
  pluginSnapshot: ZenXPluginSnapshot | null;
  onOpenPlugins(): void;
  onOpenGeneral(): void;
}) {
  const computerEnabled =
    pluginSnapshot?.plugins.some(
      (plugin) => plugin.id === "computer" && plugin.enabled,
    ) === true;
  const browserEnabled =
    pluginSnapshot?.plugins.some(
      (plugin) => plugin.id === "browser" && plugin.enabled,
    ) === true;
  const [computer, setComputer] = useState<
    Readiness<ZenXComputerReadinessSnapshot>
  >({ kind: "loading" });
  const [browser, setBrowser] = useState<
    Readiness<ChromeBridgeSettingsSnapshot>
  >({ kind: "loading" });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!computerEnabled) setComputer({ kind: "loading" });
  }, [computerEnabled]);

  useEffect(() => {
    if (!browserEnabled) setBrowser({ kind: "loading" });
  }, [browserEnabled]);

  useEffect(() => {
    if (!computerEnabled && !browserEnabled) return;
    const refresh = () => setRevision((value) => value + 1);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 3000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [computerEnabled, browserEnabled]);

  useEffect(() => {
    let current = true;
    if (computerEnabled) {
      void window.zenx.computerReadiness.get().then(
        (value) => {
          if (current) setComputer({ kind: "ready", value });
        },
        () => {
          if (current) setComputer({ kind: "unavailable" });
        },
      );
    }
    if (browserEnabled) {
      void window.zenx.chromeBridge.get().then(
        (value) => {
          if (current) setBrowser({ kind: "ready", value });
        },
        () => {
          if (current) setBrowser({ kind: "unavailable" });
        },
      );
    }
    return () => {
      current = false;
    };
  }, [computerEnabled, browserEnabled, revision]);

  const computerProblems = computerEnabled ? computerIssues(computer) : [];
  const browserProblem = browserEnabled ? browserIssue(browser) : null;
  if (computerProblems.length === 0 && browserProblem === null) return null;

  return (
    <aside className="agent-readiness-notice" aria-label="Agent tool readiness">
      <div className="agent-readiness-copy">
        <strong>Agent tool setup</strong>
        {computerProblems.length > 0 ? (
          <p>
            Computer: {computerProblems.join("; ")}. Foreground control is a
            separate optional opt-in in General settings.
          </p>
        ) : null}
        {browserProblem === null ? null : (
          <p>
            {browser.kind === "ready" &&
            browser.value.effectiveMode === "user-session"
              ? "Connected Chrome"
              : "Browser"}
            : {browserProblem}
          </p>
        )}
        <small>
          These are setup checks, not a guarantee that a tool call will succeed.
          You can continue chatting.
        </small>
      </div>
      <div className="agent-readiness-actions">
        <button type="button" onClick={onOpenPlugins}>
          Plugin settings
        </button>
        {computerProblems.length > 0 ? (
          <button type="button" onClick={onOpenGeneral}>
            General settings
          </button>
        ) : null}
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          Refresh status
        </button>
      </div>
    </aside>
  );
}

function computerIssues(
  status: Readiness<ZenXComputerReadinessSnapshot>,
): string[] {
  if (status.kind === "loading")
    return ["checking Accessibility and Screen Recording"];
  if (status.kind === "unavailable")
    return ["setup status is unavailable; refresh or open Plugin settings"];
  if (status.value.platform !== "darwin") return [];
  const issues: string[] = [];
  if (status.value.accessibility === "needs-setup")
    issues.push("Accessibility needs setup");
  else if (status.value.accessibility === "unknown")
    issues.push("Accessibility status is unknown");
  if (
    ["denied", "restricted", "not-determined"].includes(
      status.value.screenRecording,
    )
  )
    issues.push("Screen Recording needs setup");
  else if (status.value.screenRecording === "unknown")
    issues.push("Screen Recording status is unknown");
  return issues;
}

function browserIssue(
  status: Readiness<ChromeBridgeSettingsSnapshot>,
): string | null {
  if (status.kind === "loading") return "checking connection status";
  if (status.kind === "unavailable")
    return "connection status is unavailable; refresh or open Plugin settings";
  if (status.value.effectiveMode !== "user-session") return null;
  if (status.value.connection.state === "connected") return null;
  if (status.value.connector === "external-cdp")
    return "the configured browser endpoint is disconnected; check Browser settings";
  if (status.value.connector === "inactive")
    return "the connector is unavailable; check Browser settings and restart ZenX";
  return status.value.nativeHostRegistered
    ? "waiting for the Chrome extension; connect a tab or check Browser settings"
    : "native host setup is needed; open Browser settings";
}

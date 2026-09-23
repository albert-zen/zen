import { useEffect, useState } from "react";

import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { ChromeBridgeSettingsSnapshot } from "../../main/chrome-extension-bridge.js";
import type { ZenXComputerReadinessSnapshot } from "../../main/computer-readiness.js";
import { Icon } from "./icons.js";

type Readiness<T> =
  { kind: "loading" } | { kind: "ready"; value: T } | { kind: "unavailable" };
type Verification = {
  state: "ready" | "needs-setup" | "failed" | "unknown" | "not-applicable";
  detail?: string;
};
type VerifiedComputerSnapshot = ZenXComputerReadinessSnapshot & {
  verification?: { accessibility: Verification; screenCapture: Verification };
};
type ActionKind = "accessibility" | "screen-recording" | "browser";
type SetupIssue = {
  id: string;
  title: string;
  status: string;
  detail: string;
  icon: "computer" | "browser" | "lock" | "image";
  action?: { label: string; kind: ActionKind };
};

export function AgentReadinessNotice({
  pluginSnapshot,
  onOpenBrowserSettings,
}: {
  pluginSnapshot: ZenXPluginSnapshot | null;
  onOpenBrowserSettings(): void;
}) {
  const computerEnabled =
    pluginSnapshot?.plugins.some(
      (plugin) => plugin.id === "computer" && plugin.enabled,
    ) === true;
  const browserEnabled =
    pluginSnapshot?.plugins.some(
      (plugin) => plugin.id === "browser" && plugin.enabled,
    ) === true;
  const [computer, setComputer] = useState<Readiness<VerifiedComputerSnapshot>>(
    {
      kind: "loading",
    },
  );
  const [browser, setBrowser] = useState<
    Readiness<ChromeBridgeSettingsSnapshot>
  >({
    kind: "loading",
  });
  const [computerRevision, setComputerRevision] = useState(0);
  const [browserRevision, setBrowserRevision] = useState(0);
  const [checkingComputer, setCheckingComputer] = useState(false);
  const [checkingBrowser, setCheckingBrowser] = useState(false);
  const [openingSettings, setOpeningSettings] = useState<ActionKind | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!computerEnabled) {
      setComputer({ kind: "loading" });
      setCheckingComputer(false);
      return;
    }
    let current = true;
    setCheckingComputer(true);
    const readiness = window.zenx
      .computerReadiness as typeof window.zenx.computerReadiness & {
      probe?: () => Promise<VerifiedComputerSnapshot>;
    };
    const operation = readiness.probe?.() ?? readiness.get();
    void operation.then(
      (value) => {
        if (!current) return;
        setComputer({ kind: "ready", value });
        setCheckingComputer(false);
      },
      () => {
        if (!current) return;
        setComputer({ kind: "unavailable" });
        setCheckingComputer(false);
      },
    );
    return () => {
      current = false;
    };
  }, [computerEnabled, computerRevision]);

  useEffect(() => {
    if (!browserEnabled) {
      setBrowser({ kind: "loading" });
      setCheckingBrowser(false);
      return;
    }
    let current = true;
    setCheckingBrowser(true);
    void window.zenx.chromeBridge.get().then(
      (value) => {
        if (!current) return;
        setBrowser({ kind: "ready", value });
        setCheckingBrowser(false);
      },
      () => {
        if (!current) return;
        setBrowser({ kind: "unavailable" });
        setCheckingBrowser(false);
      },
    );
    return () => {
      current = false;
    };
  }, [browserEnabled, browserRevision]);

  useEffect(() => {
    if (!computerEnabled && !browserEnabled) return;
    const refresh = () => {
      if (computerEnabled) setComputerRevision((value) => value + 1);
      if (browserEnabled) setBrowserRevision((value) => value + 1);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = browserEnabled
      ? window.setInterval(() => {
          if (document.visibilityState === "visible")
            setBrowserRevision((value) => value + 1);
        }, 3000)
      : null;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [computerEnabled, browserEnabled]);

  const issues = [
    ...(computerEnabled ? computerIssues(computer) : []),
    ...(browserEnabled ? browserIssues(browser) : []),
  ];
  if (issues.length === 0) return null;

  const recheck = () => {
    setActionError(null);
    if (computerEnabled) setComputerRevision((value) => value + 1);
    if (browserEnabled) setBrowserRevision((value) => value + 1);
  };
  const openSettings = async (kind: ActionKind) => {
    setOpeningSettings(kind);
    setActionError(null);
    try {
      if (kind === "browser") onOpenBrowserSettings();
      else await window.zenx.computerReadiness.openSettings(kind);
    } catch (error) {
      setActionError(
        `Could not open settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setOpeningSettings(null);
    }
  };

  return (
    <aside className="agent-readiness-notice" aria-label="Tool setup">
      <div className="agent-readiness-heading">
        <div>
          <span className="agent-readiness-eyebrow">TOOL ACCESS</span>
          <h2>
            {issues.some(
              (issue) =>
                issue.status === "Check failed" ||
                issue.status === "Could not verify",
            )
              ? "Check tool access"
              : "Finish tool setup"}
          </h2>
        </div>
        <button
          type="button"
          className="agent-readiness-recheck"
          disabled={checkingComputer || checkingBrowser}
          onClick={recheck}
        >
          <Icon name="reload" size={14} aria-hidden="true" />
          {checkingComputer || checkingBrowser ? "Checking…" : "Check again"}
        </button>
      </div>
      <ul className="agent-readiness-issues">
        {issues.map((issue) => (
          <li key={issue.id} className="agent-readiness-issue">
            <span className="agent-readiness-icon" aria-hidden="true">
              <Icon name={issue.icon} size={17} />
            </span>
            <div className="agent-readiness-issue-copy">
              <div className="agent-readiness-issue-head">
                <strong>{issue.title}</strong>
                <span className="agent-readiness-status" role="status">
                  {issue.status}
                </span>
              </div>
              <p>{issue.detail}</p>
            </div>
            {issue.action ? (
              <button
                type="button"
                className="agent-readiness-action"
                disabled={openingSettings !== null}
                onClick={() => void openSettings(issue.action!.kind)}
              >
                {openingSettings === issue.action.kind
                  ? "Opening…"
                  : issue.action.label}
                <Icon name="arrow-right" size={14} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {actionError === null ? null : (
        <p className="agent-readiness-error" role="alert">
          {actionError}
        </p>
      )}
    </aside>
  );
}

function computerIssues(
  status: Readiness<VerifiedComputerSnapshot>,
): SetupIssue[] {
  if (status.kind === "loading") return [];
  if (status.kind === "unavailable")
    return [
      {
        id: "computer-check",
        title: "Computer",
        status: "Check failed",
        detail:
          "ZenX could not check Computer access. Select Check again to retry.",
        icon: "computer",
      },
    ];
  if (status.value.platform !== "darwin") return [];
  const accessibility =
    status.value.verification?.accessibility ??
    fallbackAccessibility(status.value.accessibility);
  const screenCapture =
    status.value.verification?.screenCapture ??
    fallbackScreenCapture(status.value.screenRecording);
  return [
    ...computerIssue(
      "accessibility",
      "Accessibility",
      accessibility,
      "In macOS Accessibility, enable this ZenX app and any separate ZenX helper entry. If absent, add the ZenX.app you launched, then check again.",
      "ZenX could not complete the native window check. Select Check again; the error details may help diagnose it.",
      "Open Accessibility settings",
    ),
    ...computerIssue(
      "screen-recording",
      "Screen Recording",
      screenCapture,
      "Enable ZenX in macOS Screen Recording. Already on? Reopen ZenX; if still blocked, remove its old entry and add this ZenX.app again.",
      "ZenX could not complete the window preview check. Select Check again; the error details may help diagnose it.",
      "Open Screen Recording settings",
    ),
  ];
}

function computerIssue(
  kind: "accessibility" | "screen-recording",
  title: string,
  verification: Verification,
  setupDetail: string,
  failureDetail: string,
  actionLabel: string,
): SetupIssue[] {
  if (verification.state === "ready" || verification.state === "not-applicable")
    return [];
  const status =
    verification.state === "needs-setup"
      ? kind === "screen-recording"
        ? "Check permission or restart"
        : "Needs permission"
      : verification.state === "failed"
        ? "Check failed"
        : "Could not verify";
  return [
    {
      id: kind,
      title,
      status,
      detail:
        verification.state === "needs-setup"
          ? setupDetail
          : verification.detail
            ? `${failureDetail} Details: ${verification.detail}`
            : failureDetail,
      icon: kind === "accessibility" ? "lock" : "image",
      action:
        verification.state === "needs-setup"
          ? { label: actionLabel, kind }
          : undefined,
    },
  ];
}

function fallbackAccessibility(
  value: ZenXComputerReadinessSnapshot["accessibility"],
): Verification {
  if (value === "granted") return { state: "ready" };
  if (value === "not-applicable") return { state: "not-applicable" };
  return { state: value === "needs-setup" ? "needs-setup" : "unknown" };
}

function fallbackScreenCapture(
  value: ZenXComputerReadinessSnapshot["screenRecording"],
): Verification {
  if (value === "granted") return { state: "ready" };
  if (value === "not-applicable") return { state: "not-applicable" };
  return {
    state: ["denied", "restricted", "not-determined"].includes(value)
      ? "needs-setup"
      : "unknown",
  };
}

function browserIssues(
  status: Readiness<ChromeBridgeSettingsSnapshot>,
): SetupIssue[] {
  if (status.kind === "loading") return [];
  if (status.kind === "unavailable")
    return [
      {
        id: "chrome-check",
        title: "Connected Chrome",
        status: "Could not verify",
        detail:
          "ZenX could not read the Chrome connection. Check again or review Browser settings.",
        icon: "browser",
        action: { label: "Open Browser settings", kind: "browser" },
      },
    ];
  const value = status.value;
  if (
    value.effectiveMode !== "user-session" ||
    value.connection.state === "connected"
  )
    return [];
  const [connectionStatus, detail] =
    value.connector === "external-cdp"
      ? [
          "Endpoint disconnected",
          "Start the configured Chrome debugging endpoint or change it in Browser settings.",
        ]
      : value.connector === "inactive"
        ? [
            "Connector not active",
            "Open Browser settings to apply Connected Chrome, then restart ZenX.",
          ]
        : value.nativeHostRegistered
          ? [
              "Connect a tab",
              "In Chrome, click the ZenX extension on a tab, then select Check again.",
            ]
          : [
              "Connector needs setup",
              "Open Browser settings to register the connector and load the ZenX extension.",
            ];
  return [
    {
      id: "chrome-connection",
      title: "Connected Chrome",
      status: connectionStatus,
      detail,
      icon: "browser",
      action: { label: "Open Browser settings", kind: "browser" },
    },
  ];
}

import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
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
  useTranslation("shell");
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
        i18n.t("shell:couldNotOpenSettings", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setOpeningSettings(null);
    }
  };

  return (
    <aside
      className="agent-readiness-notice"
      aria-label={i18n.t("shell:toolSetup")}
    >
      <div className="agent-readiness-heading">
        <div>
          <span className="agent-readiness-eyebrow">
            {i18n.t("shell:toolAccess")}
          </span>
          <h2>
            {issues.some(
              (issue) =>
                issue.status === i18n.t("shell:checkFailed") ||
                issue.status === i18n.t("shell:couldNotVerify"),
            )
              ? i18n.t("shell:checkToolAccess")
              : i18n.t("shell:finishToolSetup")}
          </h2>
        </div>
        <button
          type="button"
          className="agent-readiness-recheck"
          disabled={checkingComputer || checkingBrowser}
          onClick={recheck}
        >
          <Icon name="reload" size={14} aria-hidden="true" />
          {checkingComputer || checkingBrowser
            ? i18n.t("shell:checking")
            : i18n.t("shell:checkAgain")}
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
                  ? i18n.t("shell:opening")
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
        title: i18n.t("shell:computer"),
        status: i18n.t("shell:checkFailed"),
        detail: i18n.t(
          "shell:zenxCouldNotCheckComputerAccessSelectCheckAgainToRetry",
        ),
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
      i18n.t("shell:accessibility"),
      accessibility,
      i18n.t(
        "shell:inMacosAccessibilityEnableThisZenxAppAndAnySeparateZenxHelperEntryIfAbsentAddTheZenxAppYouLaunchedThenCheckAgain",
      ),
      i18n.t("shell:nativeWindowCheckFailed"),
      i18n.t("shell:openAccessibilitySettings"),
    ),
    ...computerIssue(
      "screen-recording",
      i18n.t("shell:screenRecording"),
      screenCapture,
      i18n.t("shell:screenRecordingGuidance"),
      i18n.t("shell:windowPreviewCheckFailed"),
      i18n.t("shell:openScreenRecordingSettings"),
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
        ? i18n.t("shell:checkPermissionOrRestart")
        : i18n.t("shell:needsPermission")
      : verification.state === "failed"
        ? i18n.t("shell:checkFailed")
        : i18n.t("shell:couldNotVerify");
  return [
    {
      id: kind,
      title,
      status,
      detail:
        verification.state === "needs-setup"
          ? setupDetail
          : verification.detail
            ? i18n.t("shell:readinessDetails", {
                failure: failureDetail,
                detail: verification.detail,
              })
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
        title: i18n.t("shell:connectedChrome"),
        status: i18n.t("shell:couldNotVerify"),
        detail: i18n.t(
          "shell:zenxCouldNotReadTheChromeConnectionCheckAgainOrReviewBrowserSettings",
        ),
        icon: "browser",
        action: { label: i18n.t("shell:openBrowserSettings"), kind: "browser" },
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
          i18n.t("shell:endpointDisconnected"),
          i18n.t(
            "shell:startTheConfiguredChromeDebuggingEndpointOrChangeItInBrowserSettings",
          ),
        ]
      : value.connector === "inactive"
        ? [
            i18n.t("shell:connectorNotActive"),
            i18n.t(
              "shell:openBrowserSettingsToApplyConnectedChromeThenRestartZenx",
            ),
          ]
        : value.nativeHostRegistered
          ? [
              i18n.t("shell:connectATab"),
              i18n.t(
                "shell:inChromeClickTheZenxExtensionOnATabThenSelectCheckAgain",
              ),
            ]
          : [
              i18n.t("shell:connectorNeedsSetup"),
              i18n.t(
                "shell:openBrowserSettingsToRegisterTheConnectorAndLoadTheZenxExtension",
              ),
            ];
  return [
    {
      id: "chrome-connection",
      title: i18n.t("shell:connectedChrome"),
      status: connectionStatus,
      detail,
      icon: "browser",
      action: { label: i18n.t("shell:openBrowserSettings"), kind: "browser" },
    },
  ];
}

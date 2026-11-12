import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Select } from "./ui/controls.js";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BrowserThreadTarget,
  BrowserThreadEvent,
} from "../../main/capabilities/browser-thread-observation.js";
import { Icon } from "./icons.js";
import { BrowserExternalOpen } from "./browser-external-open.js";

const selections = new Map<string, string>();
export function BrowserThreadPanel({
  threadId,
  title,
  open,
  onOpenChange,
  providerRevision,
  embedded = false,
  fixedTargetId,
  activityCount = 0,
  activityFailed = false,
}: {
  threadId: string;
  title: string;
  open: boolean | undefined;
  onOpenChange(open: boolean): void;
  providerRevision: unknown;
  embedded?: boolean;
  fixedTargetId?: string;
  activityCount?: number;
  activityFailed?: boolean;
}) {
  useTranslation("panels");
  const [targets, setTargets] = useState<BrowserThreadTarget[]>([]);
  const [catalogReceived, setCatalogReceived] = useState(false);
  const [selection, setSelection] = useState(() => ({
    threadId,
    targetId: selections.get(threadId),
  }));
  const targetId =
    selection.threadId === threadId
      ? selection.targetId
      : selections.get(threadId);
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<{
    status: string;
    message: string;
    capturedAt?: string;
    details?: string;
  }>({
    status: "idle",
    message: "",
  });
  const statusMessage =
    status.capturedAt !== undefined
      ? i18n.t("panels:lastSnapshot", {
          time: new Date(status.capturedAt).toLocaleTimeString(
            i18n.resolvedLanguage,
          ),
        })
      : browserStatusMessage(status.message);
  const [externalBusy, setExternalBusy] = useState(false);
  const [externalError, setExternalError] = useState("");
  const externalGeneration = useRef(0);
  const externalPending = useRef(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  const [width, setWidth] = useState(520);
  const imageRef = useRef<HTMLImageElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useLayoutEffect(() => {
    let active = true;
    let sequence = 0;
    let live = false;
    let currentTarget: string | undefined = fixedTargetId ?? targetId;
    const resetExternal = () => {
      externalGeneration.current++;
      externalPending.current = false;
      setExternalBusy(false);
      setExternalError("");
    };
    resetExternal();
    const clear = () => {
      imageRef.current?.removeAttribute("src");
      setHasFrame(false);
      sequence = 0;
    };
    clear();
    // A new subscription must publish its own target before external opening.
    setTargets([]);
    setCatalogReceived(false);
    setSelectedId(undefined);
    setStatus({ status: "idle", message: "" });
    // Fixed peer panes share one frame IPC lane. Hidden peers must not replace
    // the selected pane's subscription; their metadata lives in the catalog.
    if (fixedTargetId !== undefined && (!open || !visible)) return;
    const receive = (event: BrowserThreadEvent) => {
      if (!active) return;
      if (event.type === "targets") {
        const selected =
          event.selectedId === (fixedTargetId ?? targetId) &&
          event.targets.some((target) => target.id === event.selectedId)
            ? event.selectedId
            : undefined;
        if (currentTarget !== selected) {
          resetExternal();
          live = false;
          clear();
        }
        currentTarget = selected;
        setTargets(event.targets);
        setCatalogReceived(true);
        setSelectedId(selected);
      } else if (event.type === "status") {
        live = event.status === "live";
        if (!live) clear();
        setStatus({
          status: event.status,
          message: event.message,
          details: event.details,
        });
      } else if (event.type === "snapshot") {
        if (!open || !visible || currentTarget === undefined) return;
        const image = imageRef.current;
        if (image) {
          image.src = `data:${event.mimeType};base64,${event.data}`;
          image.width = event.width;
          image.height = event.height;
          setHasFrame(true);
        }
        setStatus({
          status: "snapshot",
          message: "",
          capturedAt: event.capturedAt,
        });
      } else if (
        event.type === "frame" &&
        currentTarget !== undefined &&
        live &&
        open &&
        visible &&
        event.frame.sequence > sequence
      ) {
        sequence = event.frame.sequence;
        const image = imageRef.current;
        if (image) {
          image.src = `data:${event.frame.mimeType};base64,${event.frame.data}`;
          image.width = event.frame.width;
          image.height = event.frame.height;
          setHasFrame(true);
        }
      }
    };
    const stop = window.zenx.browserObservation.subscribe(
      {
        threadId,
        frames:
          open === true && visible && (fixedTargetId ?? targetId) !== undefined,
        ...((fixedTargetId ?? targetId) === undefined
          ? {}
          : { targetId: fixedTargetId ?? targetId }),
      },
      receive,
    );
    return () => {
      active = false;
      externalGeneration.current++;
      stop();
      imageRef.current?.removeAttribute("src");
    };
  }, [threadId, targetId, open, visible, providerRevision, fixedTargetId]);
  const close = () => {
    setExpanded(false);
    openChange.current(false);
    document.getElementById("thread-browser-toggle")?.focus();
  };
  useEffect(() => {
    if (!open || embedded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (expanded) {
        setExpanded(false);
        expandRef.current?.focus();
      } else if (
        (event.target as Element | null)?.closest?.(".browser-thread-panel")
      )
        close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, expanded]);
  if (!open) return null;
  const selected = targets.find((target) => target.id === selectedId);
  const failed = status.status === "failed";
  const unresolvedTarget =
    catalogReceived && (fixedTargetId ?? targetId) !== undefined && !selected;
  const emptyCatalog =
    catalogReceived && targets.length === 0 && !unresolvedTarget;
  const statusTitle = failed
    ? i18n.t("panels:browserObservationFailed")
    : unresolvedTarget
      ? i18n.t("panels:selectedPageUnavailable")
      : status.status === "unavailable"
        ? i18n.t("panels:browserObservationUnavailable")
        : status.status === "connecting"
          ? i18n.t("panels:connecting")
          : hasFrame
            ? status.status === "snapshot"
              ? i18n.t("panels:snapshot")
              : i18n.t("panels:live")
            : !catalogReceived
              ? i18n.t("panels:browserObservationPending")
              : emptyCatalog
                ? i18n.t("panels:noPageForThisThread")
                : selected
                  ? i18n.t("panels:waitingForABrowserImage")
                  : i18n.t("panels:browserPageNotSelected");
  const explanation =
    failed || status.details
      ? browserFailureReason(status.message, status.details)
      : (unresolvedTarget &&
        statusMessage === i18n.t("panels:browserPageNotSelected")
          ? ""
          : statusMessage) ||
        (emptyCatalog ? i18n.t("panels:askTheAgentToOpenOrInspect") : "");
  // The Host's original local error is evidence, not markup or a second summary.
  const errorDetails = status.details || (failed ? status.message : undefined);
  const observationStatus = (
    <div className="browser-observation-feedback" data-status={status.status}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <strong>{statusTitle}</strong>
        {explanation && explanation !== statusTitle ? (
          <small>{explanation}</small>
        ) : null}
      </div>
      {errorDetails ? (
        <details
          className="browser-observation-error-details"
          key={errorDetails}
        >
          <summary>{i18n.t("panels:browserObservationErrorDetails")}</summary>
          <pre tabIndex={0}>{errorDetails}</pre>
        </details>
      ) : null}
    </div>
  );
  const openExternal = async () => {
    if (
      !selected ||
      selected.canOpenExternally !== true ||
      externalPending.current
    )
      return;
    externalPending.current = true;
    setExternalBusy(true);
    setExternalError("");
    const generation = externalGeneration.current;
    try {
      await window.zenx.browserObservation.openExternal(threadId, selected.id);
    } catch {
      if (generation === externalGeneration.current)
        setExternalError(i18n.t("panels:openCurrentPageFailed"));
    } finally {
      if (generation === externalGeneration.current) {
        externalPending.current = false;
        setExternalBusy(false);
      }
    }
  };
  const choose = (value: string) => {
    if (value) selections.set(threadId, value);
    else selections.delete(threadId);
    setSelection({ threadId, targetId: value || undefined });
  };
  return (
    <aside
      className={`browser-thread-panel${embedded ? " embedded" : ""}`}
      aria-label={i18n.t("panels:browserFor", { title })}
      data-expanded={expanded}
      data-agent-active={activityCount > 0}
      style={{ "--browser-panel-width": `${width}px` } as React.CSSProperties}
    >
      <div
        className="browser-panel-resizer"
        role="separator"
        aria-label={i18n.t("panels:browserPanelWidth")}
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={780}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setWidth((current) =>
              Math.max(
                360,
                Math.min(780, current + (event.key === "ArrowLeft" ? 20 : -20)),
              ),
            );
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setWidth(
              Math.max(
                360,
                Math.min(
                  780,
                  event.currentTarget.parentElement!.getBoundingClientRect()
                    .right - event.clientX,
                ),
              ),
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      <header className="browser-panel-heading">
        <div>
          <strong>{i18n.t("panels:browser")}</strong>
          <small>{title}</small>
        </div>
        <div>
          <button
            ref={expandRef}
            type="button"
            className="icon-button"
            aria-label={
              expanded
                ? i18n.t("panels:restoreBrowserPanel")
                : i18n.t("panels:expandBrowserView")
            }
            title={
              expanded
                ? i18n.t("panels:restoreBrowserPanel")
                : i18n.t("panels:expandBrowserView")
            }
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon name={expanded ? "minimize" : "maximize"} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={i18n.t("panels:closeBrowserPanel")}
            onClick={close}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div className="browser-panel-target">
        {fixedTargetId ? (
          <>
            {selected ? (
              <strong className="browser-selected-title" title={selected.title}>
                {selected.title || selected.url}
              </strong>
            ) : null}
            <span className="browser-read-only-label">
              {i18n.t("panels:externalReadOnly")}
            </span>
          </>
        ) : (
          <>
            <label htmlFor="thread-browser-target">
              {i18n.t("panels:page")}
            </label>
            <Select
              id="thread-browser-target"
              value={targetId ?? ""}
              onValueChange={(value) => choose(value)}
            >
              <option value="">{i18n.t("panels:chooseBrowserPage")}</option>
              {targetId !== undefined &&
              !targets.some((target) => target.id === targetId) ? (
                <option value={targetId}>
                  {catalogReceived
                    ? i18n.t("panels:selectedPageUnavailable")
                    : i18n.t("panels:browserObservationPending")}
                </option>
              ) : null}
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.backendId === "workspace"
                    ? i18n.t("panels:workspaceBrowserTarget")
                    : target.backendId === "connected"
                      ? target.connectionLabel
                        ? `${target.connectionLabel} · `
                        : i18n.t("panels:connectedBrowserTarget")
                      : ""}
                  {target.title || target.url}
                </option>
              ))}
            </Select>
          </>
        )}
        <div className="browser-panel-location browser-url-field">
          <span title={selected?.url}>{selected?.url}</span>
          <BrowserExternalOpen
            url={selected?.url}
            onOpen={() => void openExternal()}
            disabled={
              selected?.canOpenExternally !== true ||
              externalBusy ||
              selected?.loading ||
              status.status === "connecting" ||
              status.status === "failed" ||
              status.status === "unavailable"
            }
          />
        </div>
        {externalError ? (
          <p role="alert" className="browser-ui-error">
            {externalError}
          </p>
        ) : null}
      </div>
      <div className="browser-live-page">
        <header
          className="browser-live-toolbar"
          aria-label={i18n.t("panels:browserObservation")}
        >
          <div className="browser-live-mode">
            <Icon name="layers" />
            <span>
              <strong>{i18n.t("panels:observerOnly")}</strong>
              {selected ? (
                <small>
                  {selected.mode === "live"
                    ? i18n.t("panels:livePage")
                    : i18n.t("panels:agentSnapshots")}
                </small>
              ) : null}
            </span>
          </div>
          {selected?.mode === "snapshot" ? (
            <div className="browser-observation-note">
              {i18n.t("panels:agentScreenshotsAreTemporaryLocalArtifacts")}
            </div>
          ) : null}
          {hasFrame ? observationStatus : null}
          {activityCount > 0 || activityFailed ? (
            <div className="browser-live-status">
              <span>
                {activityCount > 0 ? (
                  <small>{i18n.t("panels:browserAgentWorking")}</small>
                ) : null}
                {activityFailed ? (
                  <small className="browser-ui-error">
                    {i18n.t("panels:browserOperationFailed")}
                  </small>
                ) : null}
              </span>
            </div>
          ) : null}
        </header>
        <div className="browser-live-stage" data-has-frame={String(hasFrame)}>
          <img
            ref={imageRef}
            className="browser-live-frame"
            alt={
              selected?.mode === "live"
                ? i18n.t("panels:liveBrowserViewForThisThread")
                : i18n.t("panels:latestBrowserScreenshotForThisThread")
            }
            width={1600}
            height={1000}
          />
          {hasFrame ? null : (
            <div className="browser-live-placeholder">
              <Icon name="layers" />
              {observationStatus}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function browserFailureReason(message: string, details?: string): string {
  if (!details) return browserStatusMessage(message);
  let reason = details;
  try {
    const diagnostic: unknown = JSON.parse(details);
    if (typeof diagnostic === "string") reason = diagnostic;
    else if (
      diagnostic &&
      typeof diagnostic === "object" &&
      "message" in diagnostic &&
      typeof diagnostic.message === "string"
    )
      reason = diagnostic.message;
    else return browserStatusMessage(message);
  } catch {
    // A string rejection is already plain text, not a JSON diagnostic object.
  }
  // Show the original reason, with its complete unchanged evidence in Details.
  return (
    reason.split(/\r?\n/).find((line) => line.trim()) ||
    browserStatusMessage(message)
  );
}

function browserStatusMessage(message: string): string {
  if (!message) return "";
  if (message === "Ask the Agent to open or inspect a browser page.")
    return i18n.t("panels:askTheAgentToOpenOrInspect");
  if (
    message ===
    "Waiting for the Agent to inspect this page. This provider shows snapshots."
  )
    return i18n.t("panels:waitingForSnapshotInspection");
  if (message === "The Browser provider is no longer available.")
    return i18n.t("panels:browserProviderUnavailable");
  if (message === "No browser page is selected for this thread.")
    return i18n.t("panels:browserPageNotSelected");
  if (
    message ===
    "This browser page is no longer available. Ask the Agent to inspect it again."
  )
    return i18n.t("panels:browserPageUnavailable");
  if (message === "Showing the latest Agent screenshot, not a live stream.")
    return i18n.t("panels:browserLatestSnapshotOnly");
  if (
    message ===
    "The last screenshot expired. Ask the Agent to inspect this page again."
  )
    return i18n.t("panels:browserScreenshotExpired");
  if (
    message ===
    "The last screenshot is no longer available. Ask the Agent to inspect this page again."
  )
    return i18n.t("panels:browserScreenshotUnavailable");
  return message;
}

import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Select } from "./ui/controls.js";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BrowserThreadTarget,
  BrowserThreadEvent,
} from "../../main/capabilities/browser-thread-observation.js";
import { Icon } from "./icons.js";

const selections = new Map<string, string>();
export function BrowserThreadPanel({
  threadId,
  title,
  open,
  onOpenChange,
  providerRevision,
  embedded = false,
}: {
  threadId: string;
  title: string;
  open: boolean | undefined;
  onOpenChange(open: boolean): void;
  providerRevision: unknown;
  embedded?: boolean;
}) {
  useTranslation("panels");
  const [targets, setTargets] = useState<BrowserThreadTarget[]>([]);
  const [targetId, setTargetId] = useState<string | undefined>(() =>
    selections.get(threadId),
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<{
    status: string;
    message: string;
    capturedAt?: string;
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
      : status.status === "idle"
        ? i18n.t("panels:askTheAgentToOpenOrInspect")
        : status.message;
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
    const clear = () => {
      imageRef.current?.removeAttribute("src");
      setHasFrame(false);
      sequence = 0;
    };
    clear();
    const receive = (event: BrowserThreadEvent) => {
      if (!active) return;
      if (event.type === "targets") {
        setTargets(event.targets);
        setSelectedId(event.selectedId);
        if (
          event.targets.length > 0 &&
          open === undefined &&
          window.innerWidth >= 1100
        )
          openChange.current(true);
      } else if (event.type === "status") {
        live = event.status === "live";
        if (!live) clear();
        setStatus({ status: event.status, message: event.message });
      } else if (event.type === "snapshot") {
        if (!open || !visible) return;
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
      } else if (live && open && visible && event.frame.sequence > sequence) {
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
        frames: open === true && visible,
        ...(targetId === undefined ? {} : { targetId }),
      },
      receive,
    );
    return () => {
      active = false;
      stop();
      imageRef.current?.removeAttribute("src");
    };
  }, [threadId, targetId, open, visible, providerRevision]);
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
  const choose = (value: string) => {
    if (value) selections.set(threadId, value);
    else selections.delete(threadId);
    setTargetId(value || undefined);
  };
  return (
    <aside
      className={`browser-thread-panel${embedded ? " embedded" : ""}`}
      aria-label={`Browser for ${title}`}
      data-expanded={expanded}
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
        <label htmlFor="thread-browser-target">{i18n.t("panels:page")}</label>
        <Select
          id="thread-browser-target"
          value={targetId ?? ""}
          onValueChange={(value) => choose(value)}
        >
          <option value="">
            {i18n.t("panels:followAgent")}
            {selected ? ` · ${selected.title}` : ""}
          </option>
          {targetId !== undefined &&
          !targets.some((target) => target.id === targetId) ? (
            <option value={targetId}>
              {i18n.t("panels:selectedPageUnavailable")}
            </option>
          ) : null}
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.title || target.url}
            </option>
          ))}
        </Select>
        {targetId !== undefined ? (
          <button
            type="button"
            className="browser-follow-button"
            onClick={() => choose("")}
          >
            {i18n.t("panels:followAgent")}
          </button>
        ) : null}
        {selected ? <span title={selected.url}>{selected.url}</span> : null}
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
              <small>
                {selected?.mode === "live"
                  ? i18n.t("panels:livePage")
                  : i18n.t("panels:agentSnapshots")}
              </small>
            </span>
          </div>
          <div className="browser-live-privacy-note">
            <span>
              {i18n.t("panels:privatePageContentMayBeVisible")}{" "}
              {selected?.mode === "live"
                ? i18n.t("panels:liveFramesStayOnThisDeviceAnd")
                : i18n.t("panels:agentScreenshotsAreTemporaryLocalArtifacts")}
            </span>
          </div>
          <div
            className="browser-live-status"
            data-status={status.status}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>
              <strong>
                {status.status === "live"
                  ? "Live"
                  : status.status === "snapshot"
                    ? i18n.t("panels:snapshot")
                    : status.status === "connecting"
                      ? i18n.t("panels:connecting")
                      : status.status === "failed"
                        ? i18n.t("panels:connectionFailed")
                        : i18n.t("panels:browserObservation")}
              </strong>
              <small>{statusMessage}</small>
            </span>
          </div>
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
              <span>
                <strong>
                  {selected
                    ? i18n.t("panels:waitingForABrowserImage")
                    : i18n.t("panels:noPageForThisThread")}
                </strong>
                <small>
                  {status.status === "idle"
                    ? i18n.t("panels:askTheAgentToOpenOrInspect")
                    : status.message}
                </small>
              </span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

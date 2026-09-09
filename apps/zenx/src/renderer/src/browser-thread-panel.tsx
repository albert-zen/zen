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
}: {
  threadId: string;
  title: string;
  open: boolean | undefined;
  onOpenChange(open: boolean): void;
  providerRevision: unknown;
}) {
  const [targets, setTargets] = useState<BrowserThreadTarget[]>([]);
  const [targetId, setTargetId] = useState<string | undefined>(() =>
    selections.get(threadId),
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState({
    status: "idle",
    message: "Ask the Agent to open or inspect a tab for this thread.",
  });
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
          message: `Last snapshot · ${new Date(event.capturedAt).toLocaleTimeString()} · Not live`,
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
    if (!open) return;
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
      className="browser-thread-panel"
      aria-label={`Browser for ${title}`}
      data-expanded={expanded}
      style={{ "--browser-panel-width": `${width}px` } as React.CSSProperties}
    >
      <div
        className="browser-panel-resizer"
        role="separator"
        aria-label="Browser panel width"
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
          <strong>Browser</strong>
          <small>{title}</small>
        </div>
        <div>
          <button
            ref={expandRef}
            type="button"
            className="icon-button"
            aria-label={
              expanded ? "Restore browser panel" : "Expand browser view"
            }
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon name="layers" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close browser panel"
            onClick={close}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div className="browser-panel-target">
        <label htmlFor="thread-browser-target">Page</label>
        <select
          id="thread-browser-target"
          value={targetId ?? ""}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">
            Follow Agent{selected ? ` · ${selected.title}` : ""}
          </option>
          {targetId !== undefined &&
          !targets.some((target) => target.id === targetId) ? (
            <option value={targetId}>Selected page unavailable</option>
          ) : null}
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.title || target.url}
            </option>
          ))}
        </select>
        {targetId !== undefined ? (
          <button
            type="button"
            className="browser-follow-button"
            onClick={() => choose("")}
          >
            Follow Agent
          </button>
        ) : null}
        {selected ? <span title={selected.url}>{selected.url}</span> : null}
      </div>
      <div className="browser-live-page">
        <header
          className="browser-live-toolbar"
          aria-label="Browser observation"
        >
          <div className="browser-live-mode">
            <Icon name="layers" />
            <span>
              <strong>Observer only</strong>
              <small>
                {selected?.mode === "live" ? "Live page" : "Agent snapshots"}
              </small>
            </span>
          </div>
          <div className="browser-live-privacy-note">
            <span>
              Private page content may be visible ·{" "}
              {selected?.mode === "live"
                ? "Live frames stay on this device and are not recorded."
                : "Agent screenshots are temporary local artifacts."}
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
                    ? "Snapshot"
                    : status.status === "connecting"
                      ? "Connecting"
                      : status.status === "failed"
                        ? "Connection failed"
                        : "Browser observation"}
              </strong>
              <small>{status.message}</small>
            </span>
          </div>
        </header>
        <div className="browser-live-stage" data-has-frame={String(hasFrame)}>
          <img
            ref={imageRef}
            className="browser-live-frame"
            alt={
              selected?.mode === "live"
                ? "Live browser view for this thread"
                : "Latest browser screenshot for this thread"
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
                    ? "Waiting for a browser image"
                    : "No page for this thread"}
                </strong>
                <small>{status.message}</small>
              </span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

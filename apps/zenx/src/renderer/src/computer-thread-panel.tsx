import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Select } from "./ui/controls.js";
import React, { useEffect, useRef, useState } from "react";
import { AgentActionPointer } from "./agent-action-pointer.js";

import type {
  ComputerThreadEvent,
  ComputerThreadTarget,
} from "../../main/capabilities/computer-thread-observation.js";

const selections = new Map<string, string>();

export function ComputerThreadPanel({
  threadId,
  active,
}: {
  threadId: string;
  active: boolean;
}) {
  useTranslation("panels");
  const [targets, setTargets] = useState<ComputerThreadTarget[]>([]);
  const [selection, setSelection] = useState(() => ({
    threadId,
    targetId: selections.get(threadId),
  }));
  const targetId =
    selection.threadId === threadId
      ? selection.targetId
      : selections.get(threadId);
  const [catalogReceived, setCatalogReceived] = useState(false);
  const [status, setStatus] = useState({
    status: "idle",
    message: "",
  });
  const [frame, setFrame] =
    useState<Extract<ComputerThreadEvent, { type: "frame" }>["frame"]>();
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  const image = useRef<HTMLImageElement>(null);
  const frameTarget = useRef<string | undefined>(undefined);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    let listening = true;
    setFrame(undefined);
    setTargets([]);
    setCatalogReceived(false);
    setStatus({ status: "idle", message: "" });
    frameTarget.current = undefined;
    image.current?.removeAttribute("src");
    if (!active || !visible) return;
    const stop = window.zenx.computerObservation.subscribe(
      { threadId, targetId, frames: targetId !== undefined },
      (event) => {
        if (!listening) return;
        if (event.type === "targets") {
          const selectedId =
            event.selectedId === targetId &&
            event.targets.some((target) => target.id === targetId)
              ? targetId
              : undefined;
          if (frameTarget.current !== selectedId) {
            frameTarget.current = selectedId;
            setFrame(undefined);
            image.current?.removeAttribute("src");
          }
          setTargets(event.targets);
          setCatalogReceived(true);
          return;
        }
        if (event.type === "status") {
          setStatus(event);
          if (event.status !== "live") {
            setFrame(undefined);
            image.current?.removeAttribute("src");
          }
          return;
        }
        if (targetId !== undefined && frameTarget.current === targetId)
          setFrame(event.frame);
      },
    );
    return () => {
      listening = false;
      stop();
    };
  }, [active, targetId, threadId, visible]);

  const selected = targets.find((target) => target.id === targetId);
  const activity = selected?.activity;
  const activityMessage = activity
    ? activity.kind === "waiting-human"
      ? i18n.t("panels:computerWaitingForHuman")
      : activity.kind === "foreground"
        ? i18n.t("panels:computerForegroundActivity")
        : activity.kind === "background-app"
          ? i18n.t("panels:computerBackgroundAppActivity", {
              application:
                selected?.target.applicationName ??
                selected?.target.bundleId ??
                selected?.target.pid,
            })
          : activity.kind === "background-window"
            ? i18n.t("panels:computerBackgroundActivity", {
                window: selected?.target.windowTitle,
              })
            : i18n.t("panels:computerActivityUnknown")
    : selected
      ? i18n.t("panels:computerNoCurrentActivity")
      : undefined;
  return (
    <section
      className="computer-thread-panel"
      data-agent-active={Boolean(activity && activity.kind !== "waiting-human")}
      aria-label={i18n.t("panels:computerWorkspace")}
    >
      <div className="computer-live-toolbar">
        <Select
          aria-label={i18n.t(
            selected && !selected.target.windowTitle
              ? "panels:computerApplication"
              : "panels:computerWindow",
          )}
          value={targetId ?? ""}
          onValueChange={(value) => {
            if (value) selections.set(threadId, value);
            else selections.delete(threadId);
            setSelection({ threadId, targetId: value || undefined });
          }}
          title={
            selected
              ? i18n.t("panels:latestComputerAction", {
                  invocationId: selected.invocationId,
                })
              : undefined
          }
        >
          <option value="">{i18n.t("panels:chooseComputerTarget")}</option>
          {targetId !== undefined && !selected ? (
            <option value={targetId}>
              {i18n.t(
                catalogReceived
                  ? "panels:selectedComputerTargetUnavailable"
                  : "panels:computerObservationPending",
              )}
            </option>
          ) : null}
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.target.windowTitle ??
                target.target.applicationName ??
                target.target.bundleId ??
                i18n.t("panels:computerApplication")}
            </option>
          ))}
        </Select>
        <span role="status" data-status={status.status}>
          {targetId !== undefined && catalogReceived && !selected
            ? i18n.t("panels:selectedComputerTargetUnavailable")
            : computerStatusMessage(status.message)}
        </span>
        {activityMessage ? (
          <span
            className="computer-activity"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-kind={activity?.kind ?? "idle"}
          >
            {activityMessage}
          </span>
        ) : null}
      </div>
      {frame ? (
        <figure className="computer-live-stage">
          <div className="computer-live-image">
            <img
              ref={image}
              className="computer-live-frame"
              src={`data:${frame.mimeType};base64,${frame.data}`}
              alt={i18n.t("panels:liveViewOf", {
                name:
                  selected?.target.windowTitle ??
                  i18n.t("panels:computerWindow"),
              })}
            />
            {selected ? (
              <AgentActionPointer
                key={`${threadId}:${selected.id}`}
                targetKey={`${threadId}:${selected.id}`}
                actionId={selected.invocationId}
                pointer={selected.pointer}
                width={frame.width}
                height={frame.height}
                capturedAt={frame.capturedAt}
                windowWidth={frame.windowWidth}
                windowHeight={frame.windowHeight}
                windowId={frame.windowId}
              />
            ) : null}
          </div>
          <figcaption>
            {i18n.t("panels:captured")}{" "}
            {new Date(frame.capturedAt).toLocaleTimeString(
              i18n.resolvedLanguage,
            )}{" "}
            · {i18n.t("panels:agentMarkerShowsActionTarget")}
          </figcaption>
        </figure>
      ) : (
        <div className="computer-live-placeholder" aria-hidden="true" />
      )}
    </section>
  );
}

function computerStatusMessage(message: string): string {
  if (!message) return "";
  if (message === "Waiting for the Agent to use a Computer window.")
    return i18n.t("panels:waitingForTheAgentToUseA");
  if (message === "This Computer provider does not support a live window view.")
    return i18n.t("panels:computerLiveViewUnsupported");
  if (message === "Computer observation is unavailable.")
    return i18n.t("panels:computerObservationUnavailable");
  if (message === "No Computer window is selected for this thread.")
    return i18n.t("panels:computerWindowNotSelected");
  return message;
}

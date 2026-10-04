import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Select } from "./ui/controls.js";
import React, { useEffect, useRef, useState } from "react";

import type {
  ComputerThreadEvent,
  ComputerThreadTarget,
} from "../../main/capabilities/computer-thread-observation.js";

export function ComputerThreadPanel({
  threadId,
  active,
}: {
  threadId: string;
  active: boolean;
}) {
  useTranslation("panels");
  const [targets, setTargets] = useState<ComputerThreadTarget[]>([]);
  const [targetId, setTargetId] = useState<string>();
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

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    setFrame(undefined);
    image.current?.removeAttribute("src");
    if (!active || !visible) return;
    return window.zenx.computerObservation.subscribe(
      { threadId, targetId, frames: true },
      (event) => {
        if (event.type === "targets") {
          setTargets(event.targets);
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
        setFrame(event.frame);
      },
    );
  }, [active, targetId, threadId, visible]);

  const selected = targets.find((target) => target.id === targetId);
  const followed = targetId === undefined ? targets.at(-1) : selected;
  return (
    <section
      className="computer-thread-panel"
      aria-label={i18n.t("panels:computerWorkspace")}
    >
      <div className="computer-live-toolbar">
        <Select
          aria-label={i18n.t("panels:computerWindow")}
          value={targetId ?? "__follow__"}
          onValueChange={(value) =>
            setTargetId(value === "__follow__" ? undefined : value)
          }
          title={
            followed
              ? `Latest Computer action ${followed.invocationId}`
              : undefined
          }
        >
          <option value="__follow__">
            {targets.length === 0
              ? i18n.t("panels:followAgent")
              : i18n.t("panels:followAgentLatestWindow")}
          </option>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.target.windowTitle ?? "Window"}
            </option>
          ))}
        </Select>
        <span role="status" data-status={status.status}>
          {status.status === "idle"
            ? i18n.t("panels:waitingForTheAgentToUseA")
            : status.message}
        </span>
      </div>
      {frame ? (
        <figure className="computer-live-stage">
          <img
            ref={image}
            className="computer-live-frame"
            src={`data:${frame.mimeType};base64,${frame.data}`}
            alt={i18n.t("panels:liveViewOf", {
              name:
                followed?.target.windowTitle ?? i18n.t("panels:computerWindow"),
            })}
          />
          <figcaption>
            {i18n.t("panels:captured")}{" "}
            {new Date(frame.capturedAt).toLocaleTimeString(
              i18n.resolvedLanguage,
            )}
          </figcaption>
        </figure>
      ) : (
        <div className="computer-live-placeholder" aria-hidden="true" />
      )}
    </section>
  );
}

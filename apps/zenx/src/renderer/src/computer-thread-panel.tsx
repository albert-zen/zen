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
  const [targets, setTargets] = useState<ComputerThreadTarget[]>([]);
  const [targetId, setTargetId] = useState<string>();
  const [status, setStatus] = useState({
    status: "idle",
    message: "Waiting for the Agent to use a Computer window.",
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
    <section className="computer-thread-panel" aria-label="Computer workspace">
      <div className="computer-live-toolbar">
        <select
          aria-label="Computer window"
          value={targetId ?? "__follow__"}
          onChange={(event) =>
            setTargetId(
              event.target.value === "__follow__"
                ? undefined
                : event.target.value,
            )
          }
          title={
            followed
              ? `Latest Computer action ${followed.invocationId}`
              : undefined
          }
        >
          <option value="__follow__">
            {targets.length === 0
              ? "Follow Agent"
              : "Follow Agent · latest window"}
          </option>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.target.windowTitle ?? "Window"}
            </option>
          ))}
        </select>
        <span role="status" data-status={status.status}>
          {status.message}
        </span>
      </div>
      {frame ? (
        <figure className="computer-live-stage">
          <img
            ref={image}
            className="computer-live-frame"
            src={`data:${frame.mimeType};base64,${frame.data}`}
            alt={`Live view of ${followed?.target.windowTitle ?? "Computer window"}`}
          />
          <figcaption>
            Captured {new Date(frame.capturedAt).toLocaleTimeString()}
          </figcaption>
        </figure>
      ) : (
        <div className="computer-live-placeholder" aria-hidden="true" />
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";

import type {
  BrowserLiveObservationEvent,
  BrowserLiveObservationStatus,
} from "../../main/capabilities/browser-provider.js";
import { Icon, type IconName } from "./icons.js";
import type { PluginUiModule, PluginUiRegistry } from "./plugin-ui-host.js";

export const BROWSER_UI_ENTRY = "zenx/bundled/browser-ui";

const initialStatus: Extract<BrowserLiveObservationEvent, { type: "status" }> =
  {
    type: "status",
    status: "idle",
    message: "Waiting for the Agent to use a browser tab.",
  };

export function registerBundledBrowserUi(
  registry: PluginUiRegistry,
): () => void {
  return registry.registerTrusted(BROWSER_UI_ENTRY, {
    "browser-page": BrowserPage,
  } satisfies PluginUiModule);
}

export function BrowserPage() {
  const [status, setStatus] = useState(initialStatus);
  const [hasFrame, setHasFrame] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const hasFrameRef = useRef(false);
  const lastSequence = useRef(0);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    const receive = (event: BrowserLiveObservationEvent) => {
      if (event.type === "status") {
        if (event.status === "connecting") lastSequence.current = 0;
        setStatus((current) =>
          current.status === event.status && current.message === event.message
            ? current
            : event,
        );
        return;
      }
      if (event.frame.sequence <= lastSequence.current) return;
      lastSequence.current = event.frame.sequence;
      const image = imageRef.current;
      if (image === null) return;
      image.src = `data:${event.frame.mimeType};base64,${event.frame.data}`;
      image.width = event.frame.width;
      image.height = event.frame.height;
      if (!hasFrameRef.current) {
        hasFrameRef.current = true;
        setHasFrame(true);
      }
    };
    const updateVisibility = () => {
      dispose?.();
      dispose = undefined;
      if (document.visibilityState === "visible") {
        dispose = window.zenx.browserObservation.subscribe(receive);
      } else {
        setStatus({
          type: "status",
          status: "idle",
          message: "Live view paused while this window is hidden.",
        });
      }
    };
    document.addEventListener("visibilitychange", updateVisibility);
    updateVisibility();
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      dispose?.();
    };
  }, []);

  const presentation = statusPresentation(status.status);
  return (
    <div className="browser-live-page">
      <div className="browser-live-intro">
        <div>
          <p className="browser-live-eyebrow">Observer only</p>
          <h2>The tab your Agent is using, as it happens.</h2>
          <p>
            This page mirrors the exact browser target selected by the latest
            Agent browser operation. It has no controls and cannot take over the
            tab.
          </p>
        </div>
        <div
          className="browser-live-status"
          data-status={status.status}
          role="status"
          aria-atomic="true"
        >
          <Icon name={presentation.icon} aria-hidden="true" />
          <span>
            <strong>{presentation.label}</strong>
            <small>{status.message}</small>
          </span>
        </div>
      </div>

      <div className="browser-live-stage" data-has-frame={String(hasFrame)}>
        <img
          ref={imageRef}
          className="browser-live-frame"
          alt="Live view of the browser tab the Agent is using"
          width="1600"
          height="1000"
        />
        {hasFrame ? null : (
          <div className="browser-live-placeholder" aria-hidden="true">
            <Icon name={presentation.icon} />
            <span>{presentation.label}</span>
          </div>
        )}
      </div>

      <aside className="browser-live-privacy" aria-label="Privacy notice">
        <Icon name="warning" aria-hidden="true" />
        <p>
          <strong>Private page content may be visible.</strong> Frames stay in
          this app on this device and are not recorded in thread history, plugin
          storage, or files.
        </p>
      </aside>
    </div>
  );
}

function statusPresentation(status: BrowserLiveObservationStatus): {
  icon: IconName;
  label: string;
} {
  switch (status) {
    case "connecting":
      return { icon: "clock", label: "Connecting" };
    case "live":
      return { icon: "search", label: "Live" };
    case "failed":
      return { icon: "warning", label: "View failed" };
    case "unavailable":
      return { icon: "warning", label: "Unavailable" };
    case "idle":
      return { icon: "layers", label: "Waiting" };
  }
}

import React, { useEffect, useRef, useState } from "react";

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
    let isLive = false;
    const clearFrame = () => {
      const image = imageRef.current;
      image?.removeAttribute("src");
      if (image !== null) {
        image.width = 1600;
        image.height = 1000;
      }
      hasFrameRef.current = false;
      lastSequence.current = 0;
      setHasFrame(false);
    };
    const stopObservation = () => {
      const stop = dispose;
      dispose = undefined;
      stop?.();
      isLive = false;
      clearFrame();
    };
    const receive = (event: BrowserLiveObservationEvent) => {
      if (event.type === "status") {
        isLive = event.status === "live";
        if (!isLive) clearFrame();
        setStatus((current) =>
          current.status === event.status && current.message === event.message
            ? current
            : event,
        );
        return;
      }
      if (!isLive) return;
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
      stopObservation();
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
      stopObservation();
    };
  }, []);

  const presentation = statusPresentation(status.status);
  return (
    <div className="browser-live-page">
      <header className="browser-live-toolbar" aria-label="Browser observation">
        <div className="browser-live-mode">
          <Icon name="layers" aria-hidden="true" />
          <span>
            <strong>Observer only</strong>
            <small>Agent browser target</small>
          </span>
        </div>
        <div className="browser-live-privacy-note">
          <Icon name="warning" aria-hidden="true" />
          <span>
            Private page content may be visible · Frames stay on this device and
            are not recorded.
          </span>
        </div>
        <div
          className="browser-live-status"
          data-status={status.status}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Icon name={presentation.icon} aria-hidden="true" />
          <span>
            <strong>{presentation.label}</strong>
            <small>{status.message}</small>
          </span>
        </div>
      </header>

      <div
        className="browser-live-stage"
        data-has-frame={String(hasFrame)}
        data-status={status.status}
      >
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
            <span>
              <strong>{presentation.placeholderTitle}</strong>
              <small>{presentation.placeholderDetail}</small>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function statusPresentation(status: BrowserLiveObservationStatus): {
  icon: IconName;
  label: string;
  placeholderTitle: string;
  placeholderDetail: string;
} {
  switch (status) {
    case "connecting":
      return {
        icon: "clock",
        label: "Connecting",
        placeholderTitle: "Connecting to the browser target",
        placeholderDetail: "The read-only view will appear here.",
      };
    case "live":
      return {
        icon: "search",
        label: "Live",
        placeholderTitle: "Waiting for the first frame",
        placeholderDetail: "The browser target is connected.",
      };
    case "failed":
      return {
        icon: "warning",
        label: "View failed",
        placeholderTitle: "The live view could not connect",
        placeholderDetail: "Use another Agent browser action to retry.",
      };
    case "unavailable":
      return {
        icon: "warning",
        label: "Unavailable",
        placeholderTitle: "The observed tab is no longer attached",
        placeholderDetail: "Ask the Agent to open or inspect a tab.",
      };
    case "idle":
      return {
        icon: "layers",
        label: "Waiting",
        placeholderTitle: "No browser target yet",
        placeholderDetail: "Ask the Agent to open or inspect a tab.",
      };
  }
}

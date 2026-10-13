import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Icon } from "./icons.js";
import { BrowserExternalOpen } from "./browser-external-open.js";
import React, { useEffect, useId, useRef, useState } from "react";
import type {
  WorkspaceBrowserCommand,
  WorkspaceBrowserTab,
} from "../../main/workspace-browser.js";

type BrowserPanelProps = {
  threadId: string;
  tab: WorkspaceBrowserTab;
  open: boolean;
};

export function WorkspaceBrowserPanel(props: BrowserPanelProps) {
  return (
    <BrowserPanel
      key={JSON.stringify([props.threadId, props.tab.id, props.open])}
      {...props}
    />
  );
}

function BrowserPanel({ threadId, tab: active, open }: BrowserPanelProps) {
  useTranslation("panels");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [mountError, setMountError] = useState("");
  const pending = useRef({ navigation: false, control: false });
  const controlDescription = useId();
  const area = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    const api = window.zenx.workspaceBrowser;
    if (!api) return; // Older renderer fixtures do not expose native browsing.
    const stopFocus = api.onFocusAddress((id) => {
      if (id === threadId) {
        addressInput.current?.focus();
        addressInput.current?.select();
      }
    });
    return () => {
      generation.current++;
      stopFocus();
    };
  }, [threadId]);
  useEffect(() => {
    setAddress(active?.url === "about:blank" ? "" : (active?.url ?? ""));
  }, [active?.id, active?.url]);
  useEffect(() => {
    if (!open || !active || !area.current) return;
    const lease = crypto.randomUUID();
    let stopped = false;
    const mount = () => {
      if (stopped) return;
      const rect = area.current?.getBoundingClientRect();
      const visible =
        document.visibilityState !== "hidden" &&
        rect &&
        rect.width > 0 &&
        rect.height > 0;
      void window.zenx.workspaceBrowser
        .mount({
          threadId,
          tabId: active.id,
          lease,
          ...(visible
            ? {
                bounds: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              }
            : {}),
        })
        .catch((reason) => {
          if (!stopped)
            setMountError(
              reason instanceof Error ? reason.message : String(reason),
            );
        });
    };
    const observer = new ResizeObserver(mount);
    observer.observe(area.current);
    window.addEventListener("resize", mount);
    window.addEventListener("scroll", mount, true);
    document.addEventListener("visibilitychange", mount);
    mount();
    return () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener("resize", mount);
      window.removeEventListener("scroll", mount, true);
      document.removeEventListener("visibilitychange", mount);
      void window.zenx.workspaceBrowser
        .mount({ threadId, lease })
        .catch(() => undefined);
    };
  }, [open, active?.id, threadId]);
  const command = async (
    operation: WorkspaceBrowserCommand,
    tabId = active?.id,
    url?: string,
  ) => {
    const control =
      operation === "take-control" || operation === "return-control";
    const lane = control ? "control" : "navigation";
    if (!open || pending.current[lane]) return;
    pending.current[lane] = true;
    const setPending = control ? setControlBusy : setBusy;
    const setCommandError = control ? setControlError : setError;
    setPending(true);
    setCommandError("");
    const request = generation.current;
    try {
      await window.zenx.workspaceBrowser.command(
        threadId,
        operation,
        tabId,
        url,
      );
      if (request !== generation.current) return;
    } catch (reason) {
      if (request === generation.current)
        setCommandError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      if (request === generation.current) {
        pending.current[lane] = false;
        setPending(false);
      }
    }
  };
  return (
    <section
      className="workspace-browser-panel"
      aria-label={i18n.t("panels:browserWorkspace")}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "l" &&
          active
        ) {
          event.preventDefault();
          addressInput.current?.focus();
          addressInput.current?.select();
        }
      }}
    >
      <div className="workspace-browser-control">
        <div
          id={controlDescription}
          role="status"
          aria-live="polite"
          tabIndex={0}
          aria-label={i18n.t("panels:browserControlStatus")}
        >
          <strong>
            {i18n.t(
              active.control === "human"
                ? "panels:browserHumanControl"
                : "panels:browserAgentControl",
            )}
          </strong>
          <p>
            {i18n.t(
              active.control === "human"
                ? "panels:browserHumanControlDetail"
                : "panels:browserAgentControlDetail",
            )}
          </p>
          {active.agentActionsInFlight > 0 ? (
            <p>
              {i18n.t("panels:browserActionsInFlight", {
                count: active.agentActionsInFlight,
              })}
            </p>
          ) : null}
          {active.agentActionOutcomeUnknown ? (
            <p>{i18n.t("panels:browserActionOutcomeUnknown")}</p>
          ) : null}
          {active.control === "agent" && active.requiresFreshObservation ? (
            <p>{i18n.t("panels:browserFreshObservationRequired")}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-describedby={controlDescription}
          aria-busy={controlBusy}
          disabled={!open || controlBusy}
          onClick={() =>
            void command(
              active.control === "human" ? "return-control" : "take-control",
            )
          }
        >
          {i18n.t(
            active.control === "human"
              ? "panels:browserReturnControl"
              : "panels:browserTakeControl",
          )}
        </button>
      </div>
      {controlError ? (
        <p role="alert" className="browser-ui-error">
          {controlError}
        </p>
      ) : null}
      {mountError ? (
        <p role="alert" className="browser-ui-error">
          {mountError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="browser-ui-error">
          {error}
        </p>
      ) : null}
      <>
        <form
          className="workspace-browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            void command("navigate", active.id, address);
          }}
        >
          <button
            type="button"
            aria-label={i18n.t("panels:back")}
            disabled={!active.canGoBack || busy}
            onClick={() => void command("back")}
          >
            <Icon name="arrow-left" />
          </button>
          <button
            type="button"
            aria-label={i18n.t("panels:forward")}
            disabled={!active.canGoForward || busy}
            onClick={() => void command("forward")}
          >
            <Icon name="arrow-right" />
          </button>
          <button
            type="button"
            aria-label={i18n.t("panels:reloadPage")}
            disabled={busy}
            onClick={() => void command("reload")}
          >
            <Icon name="reload" />
          </button>
          <div className="workspace-browser-location">
            <input
              ref={addressInput}
              aria-label={i18n.t("panels:browserAddress")}
              placeholder={i18n.t("panels:enterAUrl")}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <button
              type="submit"
              aria-label={i18n.t("panels:go")}
              title={i18n.t("panels:go")}
              disabled={busy}
            >
              <Icon name="arrow-right" />
            </button>
          </div>
          <BrowserExternalOpen
            url={active.url}
            disabled={!open || busy || active.loading}
          />
        </form>
        {active.error ? (
          <p role="alert" className="browser-ui-error">
            {active.error}
          </p>
        ) : null}
        <div
          className="workspace-browser-viewport"
          ref={area}
          aria-label={i18n.t("panels:interactiveWebPage")}
        />
      </>
    </section>
  );
}

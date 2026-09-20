import React, { useEffect, useRef, useState } from "react";
import type {
  WorkspaceBrowserCommand,
  WorkspaceBrowserTab,
} from "../../main/workspace-browser.js";
import { BrowserThreadPanel } from "./browser-thread-panel.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";

export function WorkspaceBrowserPanel({
  threadId,
  title,
  open,
  onOpenChange,
  snapshot,
  agentAvailable,
}: {
  threadId: string;
  title: string;
  open: boolean | undefined;
  onOpenChange(open: boolean): void;
  snapshot: ZenXPluginSnapshot | null;
  agentAvailable: boolean;
}) {
  const [tabs, setTabs] = useState<WorkspaceBrowserTab[]>([]);
  const [selected, setSelected] = useState<string>("attached");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const active = tabs.find((tab) => tab.id === selected);
  useEffect(() => {
    const request = ++generation.current;
    const api = window.zenx.workspaceBrowser;
    if (!api) return; // Older renderer fixtures do not expose native browsing.
    let updates = 0;
    const stop = api.onChanged((value) => {
      if (value.threadId === threadId) {
        updates++;
        setTabs(value.tabs);
        setSelected((current) =>
          current === "attached" && value.tabs.length > 0
            ? value.tabs.at(-1)!.id
            : current,
        );
      }
    });
    void api.command(threadId, "list").then(
      (value) => {
        if (request === generation.current && updates === 0) setTabs(value);
      },
      (reason) => {
        if (request === generation.current)
          setError(String(reason.message ?? reason));
      },
    );
    const stopFocus = api.onFocusAddress((id) => {
      if (id === threadId) {
        addressInput.current?.focus();
        addressInput.current?.select();
      }
    });
    return () => {
      generation.current++;
      stop();
      stopFocus();
    };
  }, [threadId]);
  useEffect(() => {
    setAddress(active?.url === "about:blank" ? "" : (active?.url ?? ""));
  }, [active?.id, active?.url]);
  useEffect(() => {
    if (selected !== "attached" && !active) setSelected("attached");
  }, [selected, active]);
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
          if (!stopped) setError(String(reason.message ?? reason));
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
    setBusy(true);
    setError("");
    const request = generation.current;
    try {
      const value = await window.zenx.workspaceBrowser.command(
        threadId,
        operation,
        tabId,
        url,
      );
      if (request !== generation.current) return;
      if (operation === "new") setSelected(value.at(-1)!.id);
      if (operation === "close" && selected === tabId)
        setSelected(value.at(-1)?.id ?? "attached");
    } catch (reason) {
      if (request === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <section
      className="workspace-browser-panel"
      aria-label="Browser workspace"
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
      <div className="workspace-browser-tabs" aria-label="Browser pages">
        <button
          type="button"
          aria-pressed={selected === "attached"}
          onClick={() => setSelected("attached")}
        >
          Attached browser
        </button>
        {tabs.map((tab) => (
          <span className="workspace-browser-tab" key={tab.id}>
            <button
              type="button"
              aria-pressed={selected === tab.id}
              title={tab.url}
              onClick={() => setSelected(tab.id)}
            >
              {tab.loading ? "Loading…" : tab.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              disabled={busy}
              onClick={() => void command("close", tab.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-label="New browser tab"
          disabled={busy}
          onClick={() => void command("new")}
        >
          +
        </button>
      </div>
      {error ? (
        <p role="alert" className="browser-ui-error">
          {error}
        </p>
      ) : null}
      {active ? (
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
              aria-label="Back"
              disabled={!active.canGoBack || busy}
              onClick={() => void command("back")}
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Forward"
              disabled={!active.canGoForward || busy}
              onClick={() => void command("forward")}
            >
              →
            </button>
            <button
              type="button"
              aria-label="Reload page"
              disabled={busy}
              onClick={() => void command("reload")}
            >
              ↻
            </button>
            <input
              ref={addressInput}
              aria-label="Browser address"
              placeholder="Enter a URL"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <button type="submit" disabled={busy}>
              Go
            </button>
          </form>
          {active.error ? (
            <p role="alert" className="browser-ui-error">
              {active.error}
            </p>
          ) : null}
          <div
            className="workspace-browser-viewport"
            ref={area}
            aria-label="Interactive web page"
          />
        </>
      ) : agentAvailable ? (
        <BrowserThreadPanel
          key={threadId}
          threadId={threadId}
          title={title}
          embedded
          open={open}
          onOpenChange={onOpenChange}
          providerRevision={snapshot}
        />
      ) : (
        <div className="browser-empty-state">
          <p>Open a shared page for you and the Agent.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void command("new")}
          >
            Open your own browser tab
          </button>
        </div>
      )}
    </section>
  );
}

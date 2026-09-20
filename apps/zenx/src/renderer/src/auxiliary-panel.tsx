import React, { useEffect, useState } from "react";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import { WorkspaceBrowserPanel } from "./workspace-browser-panel.js";
import { GenericPluginUiHost } from "./plugin-ui-host.js";
import { pluginUiRegistry, useAppearance } from "./PluginProductPage.js";
import { WorkspaceFileDrafts } from "./workspace-file-drafts.js";
import { WorkspaceFilesPanel } from "./workspace-files-panel.js";
import { Icon } from "./icons.js";

export function AuxiliaryPanel({
  threadId,
  title,
  open,
  onOpenChange,
  snapshot,
  selectedTab,
  onSelectTab,
  fileDrafts,
  workspacePath,
}: {
  fileDrafts?: WorkspaceFileDrafts;
  workspacePath?: string;
  threadId: string;
  title: string;
  open: boolean | undefined;
  onOpenChange(open: boolean): void;
  snapshot: ZenXPluginSnapshot | null;
  selectedTab?: string;
  onSelectTab(tab: string): void;
}) {
  const [localDrafts] = useState(() => new WorkspaceFileDrafts());
  const theme = useAppearance();
  const [width, setWidth] = useState(520);
  const [expanded, setExpanded] = useState(false);
  const browser =
    snapshot?.plugins.some(
      (p) => p.id === "browser" && p.enabled && p.available,
    ) ?? false;
  const panels = [...(snapshot?.panels ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
  );
  const tabs = [
    { id: "browser", title: "Browser" },
    { id: "files", title: "Files" },
    ...panels.map((p) => ({ id: `plugin:${p.key}`, title: p.title })),
  ];
  const active = tabs.some((tab) => tab.id === selectedTab)
    ? selectedTab!
    : tabs[0]!.id;
  const [filesVisited, setFilesVisited] = useState(false);
  useEffect(() => {
    if (open && active === "files") setFilesVisited(true);
  }, [open, active]);
  const panel = panels.find((p) => `plugin:${p.key}` === active);
  const close = () => {
    setExpanded(false);
    onOpenChange(false);
    document.getElementById("thread-browser-toggle")?.focus();
  };
  return (
    <aside
      id="thread-workspace-panel"
      className="auxiliary-panel"
      data-open={open === true}
      data-expanded={expanded}
      aria-label={`Side panel for ${title}`}
      style={{ "--auxiliary-width": `${width}px` } as React.CSSProperties}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          if (expanded) setExpanded(false);
          else close();
        }
      }}
    >
      <div
        className="browser-panel-resizer"
        role="separator"
        aria-label="Side panel width"
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={780}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            setWidth((value) =>
              Math.max(
                360,
                Math.min(780, value + (event.key === "ArrowLeft" ? 20 : -20)),
              ),
            );
          }
        }}
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
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
      <header className="auxiliary-heading">
        <div role="tablist" aria-label="Side panel views">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`aux-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              aria-controls={`aux-content-${tab.id}`}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % tabs.length
                        : event.key === "ArrowLeft"
                          ? (index + tabs.length - 1) % tabs.length
                          : -1;
                if (next >= 0) {
                  event.preventDefault();
                  onSelectTab(tabs[next]!.id);
                  document.getElementById(`aux-tab-${tabs[next]!.id}`)?.focus();
                }
              }}
            >
              {tab.title}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={expanded ? "Restore side panel" : "Expand side panel"}
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "compress" : "expand"} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Close side panel"
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </header>
      {
        <div
          className="auxiliary-content"
          role="tabpanel"
          id="aux-content-browser"
          aria-labelledby="aux-tab-browser"
          hidden={active !== "browser"}
        >
          <WorkspaceBrowserPanel
            threadId={threadId}
            title={title}
            agentAvailable={browser}
            open={active === "browser" ? open : false}
            onOpenChange={onOpenChange}
            snapshot={snapshot}
          />
        </div>
      }
      <div
        className="auxiliary-content"
        role="tabpanel"
        id="aux-content-files"
        aria-labelledby="aux-tab-files"
        hidden={active !== "files"}
      >
        {filesVisited || (open && active === "files") ? (
          <WorkspaceFilesPanel
            key={threadId}
            threadId={threadId}
            drafts={fileDrafts ?? localDrafts}
            workspacePath={workspacePath}
          />
        ) : null}
      </div>
      {open && panel && snapshot ? (
        <div
          className="auxiliary-content"
          role="tabpanel"
          id={`aux-content-${active}`}
          aria-labelledby={`aux-tab-${active}`}
        >
          <GenericPluginUiHost
            key={panel.key}
            className="auxiliary-plugin"
            registry={pluginUiRegistry}
            snapshot={snapshot}
            pluginId={panel.pluginId}
            surfaceId={panel.surfaceId}
            context={{ route: "agent", threadId }}
            theme={theme}
            executeCommand={window.zenx.plugins.executeCommand}
            readHandle={window.zenx.plugins.readHandle}
          />
        </div>
      ) : null}
    </aside>
  );
}

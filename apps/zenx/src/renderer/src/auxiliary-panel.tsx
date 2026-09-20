import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type { WorkspaceBrowserTab } from "../../main/workspace-browser.js";
import { WorkspaceBrowserPanel } from "./workspace-browser-panel.js";
import { BrowserThreadPanel } from "./browser-thread-panel.js";
import { ComputerThreadPanel } from "./computer-thread-panel.js";
import { GenericPluginUiHost } from "./plugin-ui-host.js";
import { pluginUiRegistry, useAppearance } from "./PluginProductPage.js";
import {
  WorkspaceFileDrafts,
  fileDraftKey,
  isFileDirty,
} from "./workspace-file-drafts.js";
import { WorkspaceFilesPanel } from "./workspace-files-panel.js";
import { WorkspaceFilePicker } from "./workspace-file-picker.js";
import { Icon, type IconName } from "./icons.js";

interface ContentTab {
  id: string;
  title: string;
  icon: IconName;
  path?: string;
  browser?: WorkspaceBrowserTab;
}
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
  openedTabs,
  onTabsChange,
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
  openedTabs?: string[];
  onTabsChange?(tabs: string[]): void;
}) {
  const [localDrafts] = useState(() => new WorkspaceFileDrafts());
  const drafts = fileDrafts ?? localDrafts;
  const entries = useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const [localTabs, setLocalTabs] = useState<string[]>([]);
  const order = openedTabs ?? localTabs;
  const setOrder = onTabsChange ?? setLocalTabs;
  const theme = useAppearance();
  const [width, setWidth] = useState(520);
  const [expanded, setExpanded] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const [browserTabs, setBrowserTabs] = useState<WorkspaceBrowserTab[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [closingFiles, setClosingFiles] = useState<string[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const browser =
    snapshot?.plugins.some(
      (p) => p.id === "browser" && p.enabled && p.available,
    ) ?? false;
  const computer =
    snapshot?.plugins.some(
      (p) => p.id === "computer" && p.enabled && p.available,
    ) ?? false;
  const panels = [...(snapshot?.panels ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
  );
  const files = [...entries.entries()].filter(
    ([key]) => JSON.parse(key)[0] === threadId,
  );
  const candidates: ContentTab[] = [
    ...files.map(([, draft]) => ({
      id: `file:${draft.base.path}`,
      title: draft.base.path.split("/").at(-1)!,
      icon: "file" as const,
      path: draft.base.path,
    })),
    ...browserTabs.map((tab) => ({
      id: `browser:${tab.id}`,
      title: tab.title || "New tab",
      icon: "browser" as const,
      browser: tab,
    })),
    ...(computer
      ? [{ id: "computer", title: "Computer", icon: "computer" as const }]
      : []),
    ...(browser
      ? [
          {
            id: "attached",
            title: "Attached browser",
            icon: "browser" as const,
          },
        ]
      : []),
    ...panels.map((panel) => ({
      id: `plugin:${panel.key}`,
      title: panel.title,
      icon: "layers" as const,
    })),
  ];
  const available = new Map(candidates.map((tab) => [tab.id, tab]));
  const ids = [
    ...new Set([
      ...order,
      ...candidates
        .filter((tab) => tab.path || tab.browser)
        .map((tab) => tab.id),
      ...(selectedTab && available.has(selectedTab) ? [selectedTab] : []),
    ]),
  ].filter((id) => available.has(id));
  const signature = JSON.stringify(ids);
  useEffect(() => {
    if (JSON.stringify(order) !== signature) setOrder(JSON.parse(signature));
  }, [signature, order, setOrder]);
  const tabs = ids.map((id) => available.get(id)!);
  const active =
    selectedTab && ids.includes(selectedTab) ? selectedTab : ids[0];
  const showChooser = choosing || tabs.length === 0;
  const select = (id: string) => {
    setChoosing(false);
    setPickingFile(false);
    setError("");
    onSelectTab(id);
  };
  useEffect(() => {
    setChoosing(false);
    setPickingFile(false);
  }, [selectedTab]);
  useEffect(() => {
    const api = window.zenx.workspaceBrowser;
    if (!api) return;
    let alive = true;
    let changed = false;
    const stop = api.onChanged((value) => {
      if (alive && value.threadId === threadId) {
        changed = true;
        setBrowserTabs(value.tabs);
      }
    });
    void api.command(threadId, "list").then(
      (value) => {
        if (alive && !changed) setBrowserTabs(value);
      },
      (reason) => {
        if (alive) setError(String(reason.message ?? reason));
      },
    );
    return () => {
      alive = false;
      stop();
    };
  }, [threadId]);
  const add = async (id: string) => {
    setError("");
    if (id === "file") {
      setPickingFile(true);
      setChoosing(true);
      return;
    }
    if (id !== "browser") {
      setOrder([...new Set([...ids, id])]);
      select(id);
      return;
    }
    if (!window.zenx.workspaceBrowser) {
      setError("Interactive browsing is available in the ZenX desktop app.");
      return;
    }
    setBusy(true);
    try {
      const value = await window.zenx.workspaceBrowser.command(threadId, "new");
      if (!mounted.current) return;
      setBrowserTabs(value);
      const created = value.at(-1);
      if (created) select(`browser:${created.id}`);
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const openFile = async (path: string) => {
    const value = await window.zenx.workspaceFiles.read(threadId, path);
    if (!mounted.current) return;
    const key = fileDraftKey(threadId, value.path);
    const current = drafts.snapshot().get(key);
    if (!current || (!isFileDirty(current) && !current.saving))
      drafts.set(key, { base: value, text: value.text });
    select(`file:${value.path}`);
  };
  const remove = (id: string) => {
    const index = ids.indexOf(id);
    const remaining = ids.filter((value) => value !== id);
    setOrder(remaining);
    if (active === id)
      onSelectTab(remaining[Math.min(index, remaining.length - 1)] ?? "");
  };
  const closeTab = async (tab: ContentTab) => {
    setError("");
    if (tab.path) {
      const key = fileDraftKey(threadId, tab.path);
      const draft = drafts.snapshot().get(key);
      if (draft && (isFileDirty(draft) || draft.saving)) {
        if (draft.conflict || draft.error) {
          select(tab.id);
          setError("Resolve this file's save issue before closing it.");
          return;
        }
        setClosingFiles((current) => [...new Set([...current, tab.path!])]);
        drafts.flush(key, (text, revision) =>
          window.zenx.workspaceFiles.save(threadId, tab.path!, text, revision),
        );
        return;
      }
      drafts.remove(key);
    } else if (tab.browser) {
      try {
        const value = await window.zenx.workspaceBrowser.command(
          threadId,
          "close",
          tab.browser.id,
        );
        if (!mounted.current) return;
        setBrowserTabs(value);
      } catch (reason) {
        if (mounted.current) setError(String(reason));
        return;
      }
    }
    remove(tab.id);
  };
  useEffect(() => {
    for (const path of closingFiles) {
      const key = fileDraftKey(threadId, path);
      const draft = entries.get(key);
      if (
        draft &&
        !draft.error &&
        !draft.conflict &&
        (isFileDirty(draft) || draft.saving)
      )
        continue;
      setClosingFiles((current) => current.filter((value) => value !== path));
      if (draft?.error || draft?.conflict) {
        select(`file:${path}`);
        setError("This file could not be saved. Your changes are still open.");
      } else {
        drafts.remove(key);
        remove(`file:${path}`);
      }
    }
  }, [entries, closingFiles]);
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
          if (choosing) {
            setChoosing(false);
            setPickingFile(false);
          } else if (expanded) setExpanded(false);
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
        <div role="tablist" aria-label="Workspace tabs">
          {tabs.map((tab, index) => (
            <span
              className="workspace-content-tab"
              data-active={!showChooser && active === tab.id}
              key={tab.id}
            >
              <button
                type="button"
                role="tab"
                id={`aux-tab-${tab.id}`}
                aria-selected={!showChooser && active === tab.id}
                aria-controls={`aux-content-${tab.id}`}
                tabIndex={active === tab.id ? 0 : -1}
                title={tab.path ?? tab.browser?.url ?? tab.title}
                onClick={() => select(tab.id)}
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
                    select(tabs[next]!.id);
                    document
                      .getElementById(`aux-tab-${tabs[next]!.id}`)
                      ?.focus();
                  }
                }}
              >
                <Icon name={tab.icon} />
                <span>{tab.title}</span>
                {tab.path &&
                isFileDirty(entries.get(fileDraftKey(threadId, tab.path))!) ? (
                  <span
                    className="workspace-tab-dirty"
                    aria-label="Unsaved changes"
                  >
                    •
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={`Close tab ${tab.title}`}
                disabled={tab.path ? closingFiles.includes(tab.path) : false}
                onClick={() => void closeTab(tab)}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          className="icon-button workspace-add-tab"
          aria-label="New workspace tab"
          aria-pressed={showChooser}
          onClick={() => {
            setChoosing(true);
            setPickingFile(false);
            setError("");
          }}
        >
          +
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? "Restore side panel" : "Expand side panel"}
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "compress" : "expand"} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Close side panel"
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </header>
      {error ? (
        <p className="workspace-panel-error" role="alert">
          {error}
        </p>
      ) : null}
      {showChooser ? (
        <div className="auxiliary-content workspace-new-tab">
          {pickingFile ? (
            <WorkspaceFilePicker
              threadId={threadId}
              onOpen={openFile}
              onBack={() => setPickingFile(false)}
            />
          ) : (
            <div className="workspace-tab-types" aria-label="New tab type">
              <button type="button" onClick={() => void add("file")}>
                <Icon name="file" />
                <span>File</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void add("browser")}
              >
                <Icon name="browser" />
                <span>Browser</span>
              </button>
              {computer ? (
                <button type="button" onClick={() => void add("computer")}>
                  <Icon name="computer" />
                  <span>Computer</span>
                </button>
              ) : null}
              {browser ? (
                <button type="button" onClick={() => void add("attached")}>
                  <Icon name="browser" />
                  <span>Attached browser</span>
                </button>
              ) : null}
              {panels.map((panel) => (
                <button
                  type="button"
                  key={panel.key}
                  onClick={() => void add(`plugin:${panel.key}`)}
                >
                  <Icon name="layers" />
                  <span>{panel.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {tabs.map((tab) => {
        const visible = !showChooser && active === tab.id;
        const panel = panels.find((value) => `plugin:${value.key}` === tab.id);
        return (
          <div
            className="auxiliary-content"
            key={tab.id}
            role="tabpanel"
            id={`aux-content-${tab.id}`}
            aria-labelledby={`aux-tab-${tab.id}`}
            hidden={!visible}
          >
            {tab.path ? (
              <WorkspaceFilesPanel
                threadId={threadId}
                drafts={drafts}
                workspacePath={workspacePath}
                initialPath={tab.path}
                standalone
              />
            ) : null}
            {tab.browser && visible ? (
              <WorkspaceBrowserPanel
                threadId={threadId}
                tab={tab.browser}
                open={open === true}
              />
            ) : null}
            {tab.id === "computer" ? (
              <ComputerThreadPanel
                threadId={threadId}
                active={open === true && visible}
              />
            ) : null}
            {tab.id === "attached" ? (
              <BrowserThreadPanel
                threadId={threadId}
                title={title}
                embedded
                open={open === true && visible}
                onOpenChange={onOpenChange}
                providerRevision={snapshot}
              />
            ) : null}
            {panel && snapshot ? (
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
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}

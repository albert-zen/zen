import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import {
  GenericPluginUiHost,
  type PluginUiRegistry,
  type PluginUiSurfaceProps,
} from "./plugin-ui-host.js";
import { Icon } from "./icons.js";
import { threadTitle } from "./thread-list.js";
import { useAppearance } from "./PluginProductPage.js";

/** Host-owned UI preferences are intentionally outside the serializable plugin SDK. */
export const ChildThreadSidebarContext = createContext<{
  pinnedThreadIds: readonly string[];
  changePinned(thread: NativeThreadSummary): Promise<void>;
} | null>(null);

type RelatedThread = NativeThreadSummary & { parentThreadId?: string };

export function registerSubagentsUi(registry: PluginUiRegistry): void {
  registry.registerTrusted("zenx/bundled/subagents-ui", {
    "subagents-panel": SubagentsPanel,
  });
}

/** The Host mounts only contributions admitted by the enabled Plugin Catalog. */
export function PluginThreadHeaders({
  snapshot,
  threadId,
  threads,
  navigate,
  registry,
}: {
  snapshot: ZenXPluginSnapshot;
  threadId: string;
  threads: readonly NativeThreadSummary[];
  navigate(route: string): void;
  registry?: PluginUiRegistry;
}) {
  useTranslation("panels");
  const theme = useAppearance();
  // Registry is injected by App to keep plugin registration independent of mounting.
  if (registry === undefined || !snapshot.threadHeaders?.length) return null;
  return (
    <div className="plugin-thread-headers">
      {[...snapshot.threadHeaders]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((header) => (
          <GenericPluginUiHost
            key={`${header.key}:${threadId}`}
            registry={registry}
            snapshot={snapshot}
            pluginId={header.pluginId}
            surfaceId={header.surfaceId}
            context={{
              threadId,
              threads,
              panelKey: snapshot.panels.find(
                (panel) => panel.pluginId === header.pluginId,
              )?.key,
            }}
            theme={theme}
            navigate={navigate}
            executeCommand={window.zenx.plugins.executeCommand}
            readHandle={window.zenx.plugins.readHandle}
          />
        ))}
    </div>
  );
}

function contextThreads(value: unknown): RelatedThread[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is RelatedThread =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.threadId === "string" &&
      typeof entry.status === "string",
  );
}

function useRelatedThreads(sdk: PluginUiSurfaceProps["sdk"]) {
  const parent =
    typeof sdk.context.threadId === "string" ? sdk.context.threadId : "";
  const [loaded, setLoaded] = useState<RelatedThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const commands = useRef(sdk.commands);
  commands.current = sdk.commands;
  useEffect(() => {
    let current = true;
    setLoaded([]);
    setError(null);
    if (!parent) return;
    void commands.current
      .execute("list", { parentThreadId: parent })
      .then((result: unknown) => {
        if (!current) return;
        const data = result as { threads?: unknown };
        setLoaded(contextThreads(data?.threads));
      })
      .catch((cause: unknown) => {
        if (current) setError(message(cause));
      });
    return () => {
      current = false;
    };
  }, [parent, revision]);
  // Live Host summaries override the initial bounded plugin query.
  const all = [
    ...new Map(
      [...loaded, ...contextThreads(sdk.context.threads)].map((entry) => [
        entry.threadId,
        entry,
      ]),
    ).values(),
  ];
  return {
    parent,
    all,
    error,
    refresh: () => setRevision((value) => value + 1),
  };
}

export function CreateSideChat({
  parent,
  active = true,
  execute,
  navigate,
  beginNavigation,
  onCreated,
}: {
  parent: string;
  active?: boolean;
  execute(input: {
    parentThreadId: string;
    mode: "side-chat";
  }): Promise<unknown>;
  navigate(route: string): void;
  /** Capture the shell’s current navigation intent before creation starts. */
  beginNavigation?(): () => boolean;
  onCreated?(): void;
}) {
  useTranslation("panels");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const epoch = useRef(0);
  useLayoutEffect(() => {
    epoch.current += 1;
    return () => {
      epoch.current += 1;
    };
  }, [parent, active]);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const create = async () => {
    if (inflight.current || !active) return;
    inflight.current = true;
    const source = parent;
    const requestEpoch = epoch.current;
    setBusy(true);
    setError(null);
    try {
      const canNavigate = beginNavigation?.();
      const result = (await execute({
        parentThreadId: source,
        mode: "side-chat",
      })) as { thread?: { id?: string }; threadId?: string };
      const id = result.thread?.id ?? result.threadId;
      if (!id) throw new Error(i18n.t("panels:newConversationUnidentified"));
      if (mounted.current && epoch.current === requestEpoch) {
        onCreated?.();
        if (canNavigate?.() ?? true)
          navigate(`/threads/${encodeURIComponent(id)}?view=panel`);
      }
    } catch (cause) {
      if (mounted.current && epoch.current === requestEpoch)
        setError(message(cause));
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="subagent-create">
      <button
        type="button"
        className="subagent-create-button"
        aria-label={i18n.t("panels:newSideChat")}
        title={i18n.t("panels:forkThisConversationIntoASideChat")}
        disabled={!parent || busy || !active}
        onClick={() => void create()}
      >
        <Icon name="plus" />
        <span>
          {busy ? i18n.t("panels:creating") : i18n.t("panels:sideChat")}
        </span>
      </button>
      {error ? (
        <p className="subagent-create-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Ancestors share the topbar line with App's existing current-title editor. */
export function ThreadBreadcrumbAncestors({
  threadId,
  threads,
  navigate,
}: {
  threadId: string;
  threads: readonly NativeThreadSummary[];
  navigate(route: string): void;
}) {
  useTranslation("panels");
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  const ancestors: Array<{ threadId: string; title: string }> = [];
  const visited = new Set([threadId]);
  let parentId = byId.get(threadId)?.parentThreadId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    ancestors.unshift({
      threadId: parentId,
      title: parent ? threadTitle(parent) : i18n.t("panels:parentConversation"),
    });
    parentId = parent?.parentThreadId;
  }
  if (!ancestors.length) return null;
  return (
    <nav
      className="thread-breadcrumb-ancestors"
      aria-label={i18n.t("panels:parentConversations")}
    >
      {ancestors.map((ancestor) => (
        <React.Fragment key={ancestor.threadId}>
          <button
            type="button"
            title={ancestor.title}
            onClick={() =>
              navigate(`/threads/${encodeURIComponent(ancestor.threadId)}`)
            }
          >
            {ancestor.title}
          </button>
          <span aria-hidden="true">/</span>
        </React.Fragment>
      ))}
    </nav>
  );
}

function SubagentsPanel({ sdk }: PluginUiSurfaceProps) {
  useTranslation("panels");
  const { parent, all, error, refresh } = useRelatedThreads(sdk);
  const [showArchived, setShowArchived] = useState(false);
  const render = (
    parentId: string,
    visited: ReadonlySet<string>,
  ): React.ReactNode => {
    const children = all.filter(
      (entry) =>
        entry.parentThreadId === parentId &&
        (showArchived || !entry.archived) &&
        !visited.has(entry.threadId),
    );
    if (!children.length) return null;
    return (
      <ul className="subagent-tree">
        {children.map((child) => (
          <li key={child.threadId}>
            <div className="subagent-tree-entry">
              <button
                type="button"
                className="subagent-tree-row"
                onClick={() =>
                  sdk.navigation.navigate(
                    `/threads/${encodeURIComponent(child.threadId)}?view=panel`,
                  )
                }
              >
                <Icon name="users" />
                <span className="subagent-tree-title">
                  {threadTitle(child)}
                </span>
                <span className="subagent-tree-status">
                  {child.archived
                    ? i18n.t("panels:archivedStatus")
                    : child.status === "active"
                      ? i18n.t("shell:working")
                      : child.status === "systemError"
                        ? i18n.t("panels:unavailable")
                        : i18n.t("panels:idleStatus")}
                </span>
              </button>
              <ChildThreadPin
                thread={child}
                active={sdk.context.active !== false}
              />
            </div>
            {visited.size < 32
              ? render(child.threadId, new Set([...visited, child.threadId]))
              : null}
          </li>
        ))}
      </ul>
    );
  };
  const tree = render(parent, new Set([parent]));
  return (
    <section
      className="subagents-panel"
      aria-label={i18n.t("panels:subagentConversations")}
    >
      <header>
        <strong>{i18n.t("panels:subagents")}</strong>
        <CreateSideChat
          key={parent}
          parent={parent}
          active={sdk.context.active !== false}
          execute={(input) => sdk.commands.execute("create", input)}
          navigate={sdk.navigation.navigate}
          onCreated={refresh}
        />
      </header>
      {error ? (
        <p role="alert">
          {error}
          <button type="button" onClick={refresh}>
            {i18n.t("panels:retry")}
          </button>
        </p>
      ) : null}
      {tree ?? (
        <p className="subagent-empty">{i18n.t("panels:noSubagentsYet")}</p>
      )}
      {all.some((entry) => entry.archived && entry.parentThreadId) ? (
        <label className="subagent-archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          {i18n.t("panels:showArchived")}
        </label>
      ) : null}
    </section>
  );
}

function ChildThreadPin({
  thread,
  active,
}: {
  thread: NativeThreadSummary;
  active: boolean;
}) {
  const sidebar = useContext(ChildThreadSidebarContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const epoch = useRef(0);
  useLayoutEffect(() => {
    epoch.current += 1;
    setError(null);
    return () => {
      epoch.current += 1;
    };
  }, [thread.threadId, active]);
  if (!sidebar || thread.archived) return null;
  const pinned = sidebar.pinnedThreadIds.includes(thread.threadId);
  const label = i18n.t(
    pinned ? "shell:removeFromSidebar" : "shell:pinToSidebar",
  );
  const change = async () => {
    if (inflight.current || !active) return;
    const requestEpoch = epoch.current;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await sidebar.changePinned(thread);
    } catch (cause) {
      if (epoch.current === requestEpoch) setError(message(cause));
    } finally {
      inflight.current = false;
      // The row stays mounted when its panel hides; an old completion only
      // releases its busy affordance, never changes selection or visibility.
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="subagent-sidebar-action">
      <button
        type="button"
        className="subagent-sidebar-pin"
        aria-label={`${label}: ${threadTitle(thread)}`}
        aria-pressed={pinned}
        title={i18n.t("shell:childSidebarVisibilityHint")}
        disabled={busy || !active}
        onClick={() => void change()}
      >
        <Icon name={pinned ? "pin-off" : "pin"} />
        <span>{label}</span>
      </button>
      {error ? (
        <p className="subagent-create-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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

function CreateSideChat({
  sdk,
  parent,
  onCreated,
}: {
  sdk: PluginUiSurfaceProps["sdk"];
  parent: string;
  onCreated(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const active = sdk.context.active !== false;
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
      const result = (await sdk.commands.execute("create", {
        parentThreadId: source,
        mode: "side-chat",
      })) as { thread?: { id?: string }; threadId?: string };
      const id = result.thread?.id ?? result.threadId;
      if (!id) throw new Error("The new conversation could not be identified.");
      if (mounted.current && epoch.current === requestEpoch) {
        onCreated();
        sdk.navigation.navigate(
          `/threads/${encodeURIComponent(id)}?view=panel`,
        );
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
        aria-label="New side chat"
        title="Fork this conversation into a side chat"
        disabled={!parent || busy || !active}
        onClick={() => void create()}
      >
        <Icon name="plus" />
        <span>{busy ? "Creating…" : "Side chat"}</span>
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
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  const ancestors: Array<{ threadId: string; title: string }> = [];
  const visited = new Set([threadId]);
  let parentId = byId.get(threadId)?.parentThreadId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    ancestors.unshift({
      threadId: parentId,
      title: parent ? threadTitle(parent) : "Parent conversation",
    });
    parentId = parent?.parentThreadId;
  }
  if (!ancestors.length) return null;
  return (
    <nav
      className="thread-breadcrumb-ancestors"
      aria-label="Parent conversations"
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
              <span className="subagent-tree-title">{threadTitle(child)}</span>
              <span className="subagent-tree-status">
                {child.archived
                  ? "Archived"
                  : child.status === "active"
                    ? "Working"
                    : child.status === "systemError"
                      ? "Unavailable"
                      : "Idle"}
              </span>
            </button>
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
    <section className="subagents-panel" aria-label="Subagent conversations">
      <header>
        <strong>Subagents</strong>
        <CreateSideChat
          key={parent}
          sdk={sdk}
          parent={parent}
          onCreated={refresh}
        />
      </header>
      {error ? (
        <p role="alert">
          {error}
          <button type="button" onClick={refresh}>
            Retry
          </button>
        </p>
      ) : null}
      {tree ?? <p className="subagent-empty">No subagents yet.</p>}
      {all.some((entry) => entry.archived && entry.parentThreadId) ? (
        <label className="subagent-archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
      ) : null}
    </section>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

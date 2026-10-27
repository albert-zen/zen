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

import type { ModelSummary } from "../../protocol-client/index.js";
import {
  decodeModelKey,
  encodeModelKey,
} from "../../../../../src/protocol/model-key.js";
import {
  Select,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "./ui/controls.js";

export const SubagentCreationModelsContext = createContext<{
  models: readonly ModelSummary[];
  error: string | null;
}>({ models: [], error: null });

/** App owns unsent side chats, outside the native Thread catalog. */
export const SideChatDraftContext = createContext<
  | null
  | ((input: {
      parentThreadId: string;
      model?: string;
      effort?: string;
    }) => Promise<void>)
>(null);

/** Trusted shell preference only; plugin commands and canonical Threads stay unchanged. */
export const ChildThreadSidebarContext = createContext<{
  visibleSubagentThreadIds: readonly string[];
  setVisible(threadId: string, visible: boolean): Promise<void>;
} | null>(null);

type RelatedThread = NativeThreadSummary & { parentThreadId?: string };

export function registerSubagentsUi(registry: PluginUiRegistry): void {
  registry.registerTrusted("zenx/bundled/subagents-ui", {
    "subagents-panel": SubagentsSurface,
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

function CreateSideChat({
  sdk,
  parent,
  compact = false,
}: {
  sdk: PluginUiSurfaceProps["sdk"];
  parent: string;
  onCreated(): void;
  compact?: boolean;
}) {
  useTranslation("panels");
  const catalog = useContext(SubagentCreationModelsContext);
  const openDraft = useContext(SideChatDraftContext);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const parentSummary = contextThreads(sdk.context.threads).find(
    (entry) => entry.threadId === parent && entry.status !== "systemError",
  );
  const inheritedModel =
    parentSummary?.status !== "systemError" && parentSummary
      ? encodeModelKey({
          providerProfileId:
            parentSummary.currentMetadata.providerProfileId ??
            parentSummary.currentMetadata.provider,
          modelId:
            parentSummary.currentMetadata.modelId ??
            parentSummary.currentMetadata.model,
        })
      : "";
  const availableModels = catalog.models.filter((entry) => !entry.hidden);
  const selectedModel = availableModels.find(
    (entry) => entry.id === (model || inheritedModel),
  );
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const selectionInvalid =
    (model !== "" && (!selectedModel || catalog.error !== null)) ||
    (effort !== "" &&
      (catalog.error !== null ||
        !efforts.some((entry) => entry.reasoningEffort === effort)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const active = sdk.context.active !== false;
  useEffect(() => {
    if (!active || busy) setOptionsOpen(false);
  }, [active, busy]);
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
    if (inflight.current || !active || selectionInvalid) return;
    inflight.current = true;
    const source = parent;
    const requestEpoch = epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (!openDraft)
        throw new Error(i18n.t("panels:newConversationUnidentified"));
      await openDraft({
        parentThreadId: source,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
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
        className={`subagent-create-button${compact ? " subagent-create-button-compact" : ""}`}
        aria-label={i18n.t("panels:newSideChat")}
        title={i18n.t("panels:forkThisConversationIntoASideChat")}
        disabled={!parent || busy || !active || selectionInvalid}
        onClick={() => void create()}
      >
        <Icon name="plus" />
        {compact ? null : (
          <span>
            {busy ? i18n.t("panels:creating") : i18n.t("panels:sideChat")}
          </span>
        )}
      </button>
      {compact ? null : (
        <Popover
          open={optionsOpen && active && !busy}
          onOpenChange={setOptionsOpen}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="subagent-create-options icon-button"
              aria-label={i18n.t("panels:sideChatModelSettings")}
              title={i18n.t("panels:sideChatModelSettings")}
              disabled={!parent || busy || !active}
            >
              <Icon name="settings" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="subagent-model-options" align="end">
            <strong>{i18n.t("panels:sideChatModelSettings")}</strong>
            <label>
              <span>{i18n.t("panels:childModel")}</span>
              <Select
                aria-label={i18n.t("panels:childModel")}
                value={model}
                onValueChange={(value) => {
                  setModel(value);
                  setEffort("");
                }}
              >
                <option value="">{i18n.t("panels:inheritParentModel")}</option>
                {availableModels.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName} (
                    {decodeModelKey(entry.id).providerProfileId})
                  </option>
                ))}
                {model &&
                !availableModels.some((entry) => entry.id === model) ? (
                  <option value={model} disabled>
                    {i18n.t("shell:unavailableModel")}
                  </option>
                ) : null}
              </Select>
            </label>
            <label>
              <span>{i18n.t("panels:childReasoningEffort")}</span>
              <Select
                aria-label={i18n.t("panels:childReasoningEffort")}
                value={effort}
                disabled={efforts.length === 0 && effort === ""}
                onValueChange={setEffort}
              >
                <option value="">
                  {i18n.t("panels:inheritOrModelDefault")}
                </option>
                {efforts.map((entry) => (
                  <option
                    key={entry.reasoningEffort}
                    value={entry.reasoningEffort}
                  >
                    {entry.reasoningEffort}
                  </option>
                ))}
              </Select>
            </label>
            <small>{i18n.t("panels:childSelectionBeforeCreation")}</small>
            {catalog.error ? <p role="alert">{catalog.error}</p> : null}
            {selectionInvalid ? (
              <p role="alert">{i18n.t("panels:childSelectionUnavailable")}</p>
            ) : null}
          </PopoverContent>
        </Popover>
      )}
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

function SubagentsSurface({ sdk }: PluginUiSurfaceProps) {
  if (sdk.context.quickCreate === true) {
    const parent =
      typeof sdk.context.threadId === "string" ? sdk.context.threadId : "";
    return (
      <CreateSideChat
        key={parent}
        sdk={sdk}
        parent={parent}
        onCreated={() => {}}
        compact
      />
    );
  }
  return <SubagentsPanel sdk={sdk} />;
}

function SubagentSidebarVisibility({
  thread,
}: {
  thread: NativeThreadSummary;
}) {
  useTranslation("shell");
  const sidebar = useContext(ChildThreadSidebarContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (sidebar === null) return null;
  const visible = sidebar.visibleSubagentThreadIds.includes(thread.threadId);
  const change = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      await sidebar.setVisible(thread.threadId, !visible);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="subagent-sidebar-control">
      <button
        type="button"
        role="switch"
        className="subagent-sidebar-visibility"
        aria-checked={visible}
        aria-label={i18n.t("shell:showSubagentInSidebar", {
          title: threadTitle(thread),
        })}
        title={i18n.t(
          visible ? "shell:hideFromSidebar" : "shell:showInSidebar",
        )}
        aria-busy={busy}
        // Keep keyboard focus while saving; the synchronous inflight lock
        // rejects repeated pointer and keyboard activation without disabling DOM focus.
        aria-disabled={busy}
        onClick={() => void change()}
      >
        <Icon name="panel-left" />
        <span>
          {i18n.t(visible ? "shell:sidebarShown" : "shell:sidebarHidden")}
        </span>
      </button>
      {error ? (
        <p className="subagent-sidebar-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
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
              <SubagentSidebarVisibility thread={child} />
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
          sdk={sdk}
          parent={parent}
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

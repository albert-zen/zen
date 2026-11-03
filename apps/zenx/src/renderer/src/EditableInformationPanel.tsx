import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import {
  informationCatalog,
  informationDefinition,
  type InformationLayout,
  type InformationType,
  type InformationWidget,
} from "../../information-layout.js";
import type { SidebarOwner } from "../../thread-sidebar-state.js";
import type { NativeInformationEdit } from "../../native-information.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import { ConversationInformationCards } from "./ConversationInformationCards.js";
import {
  GenericPluginUiHost,
  type PluginUiRegistry,
} from "./plugin-ui-host.js";
import type { BoardConversation } from "./board-ui-state.js";
import { Icon } from "./icons.js";

export interface InformationReceipt {
  owner: SidebarOwner;
  revision: number;
  basis: string;
  layout: InformationLayout;
  members: { threadId: string; name?: string }[];
  resourceThreadId?: string;
}
type Props = {
  owner: BoardConversation;
  threads: readonly NativeThreadSummary[];
  roomMembers?: readonly { threadId: string; name?: string }[];
  snapshot: ZenXPluginSnapshot;
  registry: PluginUiRegistry;
  theme: "light" | "dark";
  navigate(route: string): void;
  /** Asking is never a layout widget and cannot be hidden or removed here. */
  attention?: ReactNode;
};
type Pending = {
  operations: NativeInformationEdit[];
  resourceThreadId?: string;
  status: "saving" | "conflict" | "unknown" | "reviewed";
};
// Disposable window-local edits survive closing the popup. This is neither
// durable state nor an admission grant, provider cache or retry queue.
const retainedEdits = new Map<string, Pending>();
const editChanged = "zenx:information-edit-changed";
function retainEdit(owner: string, pending: Pending | null, notify = true) {
  if (pending) retainedEdits.set(owner, pending);
  else retainedEdits.delete(owner);
  if (notify)
    window.dispatchEvent(
      new window.CustomEvent(editChanged, { detail: owner }),
    );
}
const titleKeys: Record<InformationType, string> = {
  "pull-requests": "informationPullRequests",
  lineage: "informationLineage",
  artifacts: "informationArtifacts",
  triggers: "threadTriggers",
  shell: "backgroundShellTitle",
  "room-members": "informationRoomMembers",
  board: "informationBoard",
};

/** Stable navigation port keeps transcript token deltas out of provider surfaces. */
export function EditableInformationPanel(props: Props) {
  const navigate = useRef(props.navigate);
  useLayoutEffect(() => {
    navigate.current = props.navigate;
  }, [props.navigate]);
  const navigateLatest = useCallback(
    (route: string) => navigate.current(route),
    [],
  );
  return <MemoizedInformationPanel {...props} navigate={navigateLatest} />;
}
function InformationPanel({
  owner,
  threads,
  roomMembers,
  snapshot,
  registry,
  theme,
  navigate,
  attention,
}: Props) {
  const { t } = useTranslation("panels");
  const ownerId = owner.kind === "thread" ? owner.threadId : owner.roomId;
  const ownerKey = `${owner.kind}:${ownerId}`;
  const scope: SidebarOwner = { kind: owner.kind, id: ownerId };
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const [receipt, setReceipt] = useState<InformationReceipt | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(
    () => retainedEdits.get(ownerKey) ?? null,
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [member, setMember] = useState("");
  const [addType, setAddType] = useState<InformationType>("board");
  const [boardAddress, setBoardAddress] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const inFlight = useRef(false);
  const readSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const accept = (next: InformationReceipt, key: string, sequence: number) => {
    if (
      !mounted.current ||
      currentOwner.current !== key ||
      readSequence.current !== sequence
    )
      return;
    setReceipt(next);
    setMember((selected) =>
      next.members.some((entry) => entry.threadId === selected)
        ? selected
        : (next.resourceThreadId ?? ""),
    );
  };
  const refresh = useCallback(async () => {
    const api = window.zenx.information;
    if (!api) {
      setError(t("informationHostUnavailable"));
      return;
    }
    const sequence = ++readSequence.current;
    try {
      const next = await api.read({ kind: owner.kind, id: ownerId });
      if (
        !mounted.current ||
        currentOwner.current !== ownerKey ||
        readSequence.current !== sequence
      )
        return;
      accept(next, ownerKey, sequence);
      if (mounted.current && currentOwner.current === ownerKey) {
        setError("");
        const draft = retainedEdits.get(ownerKey);
        if (draft?.status === "unknown") {
          const reviewed = { ...draft, status: "reviewed" as const };
          retainEdit(ownerKey, reviewed, false);
          setPending(reviewed);
        }
      }
    } catch (reason) {
      if (
        mounted.current &&
        currentOwner.current === ownerKey &&
        readSequence.current === sequence
      )
        setError(String(reason));
    }
  }, [ownerKey, owner.kind, ownerId, t]);
  useEffect(() => {
    mounted.current = true;
    setReceipt(null);
    setPending(retainedEdits.get(ownerKey) ?? null);
    setError("");
    setEditing(false);
    setMember("");
    void refresh();
    const unsubscribe = window.zenx.threadSidebar?.onChanged((state) => {
      if (
        state.owner.kind === owner.kind &&
        state.owner.id === ownerId &&
        !inFlight.current
      )
        void refresh();
    });
    const focus = () => {
      if (!inFlight.current) void refresh();
    };
    window.addEventListener("focus", focus);
    const edit = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== ownerKey) return;
      const draft = retainedEdits.get(ownerKey) ?? null;
      setPending(draft);
      if (draft?.status !== "saving" && !inFlight.current) void refresh();
    };
    window.addEventListener(editChanged, edit);
    return () => {
      ++readSequence.current;
      unsubscribe?.();
      window.removeEventListener("focus", focus);
      window.removeEventListener(editChanged, edit);
    };
  }, [ownerKey, refresh]);
  const update = async (
    operations: NativeInformationEdit[],
    resourceThreadId = member,
    explicit = false,
  ) => {
    const api = window.zenx.information;
    if (
      !receipt ||
      !api ||
      inFlight.current ||
      retainedEdits.get(ownerKey)?.status === "saving" ||
      (pendingRef.current && !explicit)
    )
      return;
    const key = ownerKey;
    const sequence = ++readSequence.current;
    const draft = {
      operations,
      ...(resourceThreadId ? { resourceThreadId } : {}),
    };
    inFlight.current = true;
    retainEdit(key, { ...draft, status: "saving" }, false);
    setBusy(true);
    setError("");
    try {
      const result = await api.update({
        owner: scope,
        expectedRevision: receipt.revision,
        basis: receipt.basis,
        ...draft,
      });
      retainEdit(key, result.applied ? null : { ...draft, status: "conflict" });
      if (!mounted.current || currentOwner.current !== key) return;
      accept(result, key, sequence);
      setPending(result.applied ? null : { ...draft, status: "conflict" });
    } catch (reason) {
      retainEdit(key, { ...draft, status: "unknown" });
      if (mounted.current && currentOwner.current === key) {
        setPending({ ...draft, status: "unknown" });
        setError(String(reason));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && currentOwner.current === key) setBusy(false);
    }
  };
  const title = (widget: InformationWidget) => t(titleKeys[widget.type]);
  const widgets = receipt?.layout.widgets ?? [];
  const locked = busy || !!pending;
  const move = (id: string, direction: -1 | 1) => {
    const index = widgets.findIndex((widget) => widget.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= widgets.length) return;
    void update([
      {
        op: "move",
        id,
        before:
          direction < 0
            ? widgets[target]!.id
            : (widgets[target + 1]?.id ?? null),
      },
    ]);
  };
  const body = (widget: InformationWidget) => {
    const source = informationDefinition(widget.type).source;
    const threadId =
      widget.binding.kind === "member"
        ? widget.binding.resourceThreadId
        : owner.kind === "thread"
          ? owner.threadId
          : undefined;
    if (
      source === "thread" &&
      (!threadId ||
        (owner.kind === "room" &&
          !receipt?.members.some((entry) => entry.threadId === threadId)))
    )
      return <p role="status">{t("informationMemberUnavailable")}</p>;
    if (widget.type === "pull-requests" || widget.type === "artifacts")
      return (
        <p role="status" data-provider-state="unavailable">
          {t(
            widget.type === "pull-requests"
              ? "informationPullRequestsUnavailable"
              : "informationArtifactsUnavailable",
          )}
        </p>
      );
    if (widget.type === "room-members")
      return receipt?.members.length ? (
        <ul className="information-members">
          {receipt.members.map((entry) => (
            <li key={entry.threadId}>
              {entry.name ??
                threads.find((row) => row.threadId === entry.threadId)?.name ??
                entry.threadId}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("informationNoMembers")}</p>
      );
    if (widget.type === "board") {
      const contribution = snapshot.information?.find(
        (entry) => entry.pluginId === "zenx-board",
      );
      const admissionId = snapshot.plugins.find(
        (entry) => entry.id === "zenx-board",
      )?.admissionId;
      return contribution ? (
        <GenericPluginUiHost
          key={`${ownerKey}:${widget.config.instanceKey}:${admissionId}`}
          registry={registry}
          snapshot={snapshot}
          pluginId={contribution.pluginId}
          surfaceId={contribution.surfaceId}
          context={{
            owner,
            admissionId,
            instanceKey: widget.config.instanceKey,
            ...(owner.kind === "room"
              ? { members: roomMembers ?? receipt?.members ?? [] }
              : {}),
          }}
          theme={theme}
          navigate={navigate}
          executeCommand={window.zenx.plugins.executeCommand}
          readHandle={window.zenx.plugins.readHandle}
        />
      ) : (
        <p role="status">{t("unavailable")}</p>
      );
    }
    return (
      <ConversationInformationCards
        threadId={threadId!}
        threads={threads}
        snapshot={snapshot}
        registry={registry}
        theme={theme}
        navigate={navigate}
        types={[widget.type]}
        triggerConfig={widget.type === "triggers" ? widget.config : undefined}
        embedded
      />
    );
  };
  return (
    <div className="editable-information-panel" data-owner={ownerKey}>
      {attention ? (
        <div className="information-attention">{attention}</div>
      ) : null}
      <div className="information-settings-toolbar">
        <span>{t("informationComponents")}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t("informationRefresh")}
          title={t("informationRefresh")}
          disabled={busy}
          onClick={() => void refresh()}
        >
          <Icon name="reload" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t("informationCustomize")}
          title={t("informationCustomize")}
          aria-pressed={editing}
          onClick={() => setEditing((value) => !value)}
        >
          <Icon name="compose" size={14} />
        </button>
      </div>
      {error ? (
        <p className="information-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="information-conflict" role="alert">
          <p>
            {t(
              pending.status === "saving"
                ? "informationSaving"
                : pending.status === "unknown"
                  ? "informationUnknownWrite"
                  : "informationConflict",
            )}
          </p>
          <details>
            <summary>{t("informationRetainedEdit")}</summary>
            <pre>{JSON.stringify(pending.operations, null, 2)}</pre>
          </details>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {t("informationReviewCurrent")}
            </button>
            <button
              type="button"
              disabled={
                busy ||
                pending.status === "unknown" ||
                pending.status === "saving"
              }
              onClick={() =>
                void update(pending.operations, pending.resourceThreadId, true)
              }
            >
              {t("informationReapply")}
            </button>
            <button
              type="button"
              disabled={busy || pending.status === "saving"}
              onClick={() => {
                retainEdit(ownerKey, null);
                setPending(null);
              }}
            >
              {t("informationDiscardEdit")}
            </button>
          </div>
        </div>
      ) : null}
      {!receipt ? (
        <p role="status">{t(error ? "unavailable" : "boardLoading")}</p>
      ) : (
        <>
          {editing ? (
            <div className="information-add-controls">
              {owner.kind === "room" ? (
                <label>
                  {t("informationSourceMember")}
                  <select
                    aria-label={t("informationSourceMember")}
                    value={member}
                    disabled={locked}
                    onChange={(event) => setMember(event.target.value)}
                  >
                    <option value="">{t("informationChooseMember")}</option>
                    {receipt.members.map((entry) => (
                      <option key={entry.threadId} value={entry.threadId}>
                        {entry.name ?? entry.threadId}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                {t("informationAddComponent")}
                <select
                  aria-label={t("informationAddComponent")}
                  value={addType}
                  disabled={locked}
                  onChange={(event) =>
                    setAddType(event.target.value as InformationType)
                  }
                >
                  {informationCatalog
                    .filter(
                      (entry) =>
                        entry.source !== "room" || owner.kind === "room",
                    )
                    .map((entry) => (
                      <option key={entry.type} value={entry.type}>
                        {t(titleKeys[entry.type])}
                      </option>
                    ))}
                </select>
              </label>
              {addType === "board" ? (
                <label>
                  {t("informationBoardAddress")}
                  <input
                    aria-label={t("informationBoardAddress")}
                    value={boardAddress}
                    maxLength={128}
                    placeholder={t("informationNewAddress")}
                    disabled={locked}
                    onChange={(event) => setBoardAddress(event.target.value)}
                  />
                </label>
              ) : null}
              <button
                type="button"
                disabled={
                  locked ||
                  (owner.kind === "room" &&
                    informationDefinition(addType).source === "thread" &&
                    !member)
                }
                onClick={() =>
                  void update([
                    {
                      op: "add",
                      type: addType,
                      ...(addType === "board" && boardAddress.trim()
                        ? { config: { instanceKey: boardAddress.trim() } }
                        : {}),
                    },
                  ])
                }
              >
                {t("informationAdd")}
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => void update([{ op: "reset" }])}
              >
                {t("informationReset")}
              </button>
              <p>{t("informationRemovalHint")}</p>
            </div>
          ) : null}
          <div className="information-widget-list">
            {widgets
              .filter((widget) => editing || widget.visible)
              .map((widget) => (
                <section
                  key={widget.id}
                  className="information-widget"
                  data-widget-id={widget.id}
                  data-visible={widget.visible}
                  draggable={editing && !locked}
                  onDragStart={(event) => {
                    setDragging(widget.id);
                    event.dataTransfer?.setData("text/plain", widget.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(event) => {
                    if (
                      editing &&
                      !locked &&
                      dragging &&
                      dragging !== widget.id
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!locked && dragging && dragging !== widget.id)
                      void update([
                        { op: "move", id: dragging, before: widget.id },
                      ]);
                    setDragging(null);
                  }}
                  onKeyDown={(event) => {
                    if (
                      editing &&
                      event.altKey &&
                      ["ArrowUp", "ArrowDown"].includes(event.key)
                    ) {
                      event.preventDefault();
                      move(widget.id, event.key === "ArrowUp" ? -1 : 1);
                    }
                  }}
                >
                  <header>
                    <button
                      type="button"
                      className="information-widget-disclosure"
                      aria-expanded={!widget.collapsed}
                      disabled={locked}
                      onClick={() =>
                        void update([
                          {
                            op: "set",
                            id: widget.id,
                            collapsed: !widget.collapsed,
                          },
                        ])
                      }
                    >
                      <Icon
                        name={
                          widget.collapsed ? "chevron-right" : "chevron-down"
                        }
                        size={13}
                      />
                      <h3>{title(widget)}</h3>
                    </button>
                    {editing ? (
                      <div className="information-widget-actions">
                        <button
                          type="button"
                          aria-label={`${t("informationMoveUp")} · ${title(widget)}`}
                          disabled={locked || widgets[0]?.id === widget.id}
                          onClick={() => move(widget.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`${t("informationMoveDown")} · ${title(widget)}`}
                          disabled={locked || widgets.at(-1)?.id === widget.id}
                          onClick={() => move(widget.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() =>
                            void update([
                              {
                                op: "set",
                                id: widget.id,
                                visible: !widget.visible,
                              },
                            ])
                          }
                        >
                          {t(
                            widget.visible
                              ? "informationHide"
                              : "informationShow",
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label={`${t("informationRemove")} · ${title(widget)}`}
                          disabled={locked}
                          onClick={() =>
                            void update([{ op: "remove", id: widget.id }])
                          }
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                  </header>
                  {editing && widget.binding.kind === "member" ? (
                    <small className="information-source-label">
                      {t("informationBoundMember", {
                        member:
                          receipt.members.find(
                            (entry) =>
                              entry.threadId ===
                              (widget.binding as { resourceThreadId: string })
                                .resourceThreadId,
                          )?.name ?? widget.binding.resourceThreadId,
                      })}
                    </small>
                  ) : null}
                  {editing && widget.type === "board" ? (
                    <small className="information-source-label">
                      {t("informationAddress", {
                        address: widget.config.instanceKey,
                      })}
                    </small>
                  ) : null}
                  {editing && widget.type === "triggers" ? (
                    <div className="information-trigger-config">
                      <label>
                        {t("informationTriggerFilter")}
                        <select
                          aria-label={`${t("informationTriggerFilter")} · ${widget.id}`}
                          value={widget.config.filter}
                          disabled={locked}
                          onChange={(event) =>
                            void update([
                              {
                                op: "set",
                                id: widget.id,
                                config: { filter: event.target.value },
                              },
                            ])
                          }
                        >
                          <option value="all">
                            {t("informationFilterAll")}
                          </option>
                          <option value="timer">
                            {t("informationFilterTimer")}
                          </option>
                          <option value="event">
                            {t("informationFilterEvent")}
                          </option>
                        </select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={widget.config.showPaused}
                          disabled={locked}
                          onChange={(event) =>
                            void update([
                              {
                                op: "set",
                                id: widget.id,
                                config: { showPaused: event.target.checked },
                              },
                            ])
                          }
                        />
                        {t("informationShowPaused")}
                      </label>
                    </div>
                  ) : null}
                  {widget.visible && !widget.collapsed ? (
                    <div className="information-widget-body">
                      {body(widget)}
                    </div>
                  ) : null}
                </section>
              ))}
          </div>
          {widgets.every((widget) => !widget.visible) ? (
            <p>{t("informationNoVisible")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
const MemoizedInformationPanel = memo(
  InformationPanel,
  (before, after) =>
    before.owner.kind === after.owner.kind &&
    (before.owner.kind === "thread"
      ? after.owner.kind === "thread" &&
        before.owner.threadId === after.owner.threadId
      : after.owner.kind === "room" &&
        before.owner.roomId === after.owner.roomId) &&
    before.threads === after.threads &&
    before.snapshot === after.snapshot &&
    before.registry === after.registry &&
    before.theme === after.theme &&
    before.navigate === after.navigate &&
    before.attention === after.attention &&
    before.roomMembers === after.roomMembers,
);

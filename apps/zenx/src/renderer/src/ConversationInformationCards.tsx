import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import { BackgroundShellStatus } from "./BackgroundShellStatus.js";
import {
  GenericPluginUiHost,
  type PluginUiRegistry,
} from "./plugin-ui-host.js";
import {
  sidebarTriggerAdmissionId,
  useSidebarTriggers,
  type SidebarTrigger,
} from "./sidebar-thread-information.js";
import { triggerSourceRoute } from "./message-source-navigation.js";
import { Icon } from "./icons.js";
import { localErrorDetail } from "../../local-error-detail.js";
import type { InformationType } from "../../information-layout.js";

type ConversationInformationProps = {
  threadId: string;
  threads: readonly NativeThreadSummary[];
  snapshot: ZenXPluginSnapshot;
  registry: PluginUiRegistry;
  theme: "light" | "dark";
  navigate(route: string): void;
  /** Dedicated question UI never shares Board fields or main Composer state. */
  attention?: ReactNode;
  types?: readonly InformationType[];
  triggerConfig?: { filter: "all" | "timer" | "event"; showPaused: boolean };
  embedded?: boolean;
};

/** Keep App's latest navigation closure without making token deltas redraw cards. */
export function ConversationInformationCards(
  props: ConversationInformationProps,
) {
  const navigate = useRef(props.navigate);
  useLayoutEffect(() => {
    navigate.current = props.navigate;
  }, [props.navigate]);
  const navigateLatest = useCallback(
    (route: string) => navigate.current(route),
    [],
  );
  return (
    <MemoizedConversationInformationContent
      key={props.threadId}
      {...props}
      navigate={navigateLatest}
    />
  );
}

/** Bounded projections with explicit native trigger controls; canonical summary/admission/attention changes still render. */
function ConversationInformationContent({
  threadId,
  threads,
  snapshot,
  registry,
  theme,
  navigate,
  attention,
  types,
  triggerConfig,
  embedded,
}: ConversationInformationProps) {
  const { t } = useTranslation("panels");
  const lineageContext = useMemo(
    () => ({ threadId, threads }),
    [threadId, threads],
  );
  const show = (type: InformationType) => !types || types.includes(type);
  const admissionId = show("triggers")
    ? sidebarTriggerAdmissionId(snapshot)
    : null;
  const owner = threads.find((thread) => thread.threadId === threadId);
  const triggerRevision = JSON.stringify([
    threadId,
    owner?.status,
    owner && "lastTurnEnd" in owner ? owner.lastTurnEnd?.id : undefined,
  ]);
  const { state, refresh } = useSidebarTriggers(admissionId, triggerRevision);
  const triggers = state.triggers.filter(
    (trigger) =>
      trigger.threadId === threadId &&
      (!triggerConfig ||
        ((triggerConfig.showPaused || trigger.active) &&
          (triggerConfig.filter === "all" ||
            (triggerConfig.filter === "timer"
              ? trigger.kind === "timer"
              : trigger.kind !== "timer")))),
  );
  const subagents = snapshot.panels.find(
    (panel) => panel.pluginId === "zenx-subagents",
  );
  const [busyTrigger, setBusyTrigger] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const busy = useRef(false);
  const current = useRef<{
    threadId: string;
    admissionId: string | null;
    triggers: readonly SidebarTrigger[];
  } | null>(null);
  useLayoutEffect(() => {
    current.current = { threadId, admissionId, triggers };
    return () => {
      current.current = null;
    };
  });
  const setTriggerActive = async (trigger: SidebarTrigger, next: boolean) => {
    const owner = current.current;
    if (
      busy.current ||
      !owner ||
      owner.threadId !== threadId ||
      owner.admissionId !== admissionId ||
      !admissionId ||
      !owner.triggers.includes(trigger) ||
      (next && trigger.definitionRevision === undefined)
    )
      return;
    busy.current = true;
    setBusyTrigger(trigger.id);
    setTriggerError(null);
    try {
      await window.zenx.plugins.executeCommand(
        "zenx-triggers",
        next ? "resume" : "cancel",
        next
          ? {
              triggerId: trigger.id,
              expectedRevision: trigger.definitionRevision,
            }
          : { triggerId: trigger.id },
      );
      await refresh(true);
    } catch (error) {
      if (
        current.current?.threadId === threadId &&
        current.current?.admissionId === admissionId
      )
        setTriggerError(localErrorDetail(error));
      // Reconcile a stale revision or a concurrent edit instead of leaving a
      // switch that no longer matches the Host definition.
      await refresh(true);
    } finally {
      busy.current = false;
      setBusyTrigger(null);
    }
  };
  return (
    <div className="conversation-information-cards">
      {attention}
      {show("triggers") ? (
        <section
          className="conversation-information-section"
          aria-label={t("threadTriggers")}
        >
          <header>
            {!embedded && (
              <h3>
                <Icon name="clock" size={15} />
                {t("threadTriggers")}
              </h3>
            )}
            {state.status === "error" && admissionId ? (
              <button
                type="button"
                className="quiet-button"
                onClick={() => void refresh(true)}
              >
                {t("retry")}
              </button>
            ) : null}
          </header>
          {state.status !== "ready" ? (
            <p role="status">
              {state.status === "loading"
                ? t("boardLoading")
                : t("unavailable")}
            </p>
          ) : triggers.length ? (
            <ul className="information-trigger-list">
              {triggers.map((trigger) => (
                <li key={trigger.id}>
                  <span className="information-trigger-main">
                    <strong title={trigger.label ?? trigger.id}>
                      {trigger.label ?? trigger.id}
                    </strong>
                    <small>{t(trigger.active ? "enabled" : "paused")}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={trigger.active}
                    aria-busy={busyTrigger === trigger.id}
                    aria-label={`${t(trigger.active ? "pauseTrigger" : "enableTrigger")} · ${trigger.label ?? trigger.id}`}
                    className="plugin-switch"
                    disabled={
                      busyTrigger !== null ||
                      (!trigger.active &&
                        trigger.definitionRevision === undefined)
                    }
                    onClick={() =>
                      void setTriggerActive(trigger, !trigger.active)
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    title={t("edit")}
                    aria-label={`${t("edit")} · ${trigger.label ?? trigger.id}`}
                    onClick={() => navigate(triggerSourceRoute(trigger.id))}
                  >
                    <Icon name="compose" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("informationNoTriggers")}</p>
          )}
          {triggerError ? (
            <details className="information-trigger-error" role="alert">
              <summary>{t("triggerToggleFailed")}</summary>
              <pre>{triggerError}</pre>
            </details>
          ) : null}
        </section>
      ) : null}
      {show("lineage") && subagents ? (
        <section className="conversation-information-section">
          <GenericPluginUiHost
            registry={registry}
            snapshot={snapshot}
            pluginId={subagents.pluginId}
            surfaceId={subagents.surfaceId}
            context={lineageContext}
            theme={theme}
            navigate={navigate}
            executeCommand={window.zenx.plugins.executeCommand}
            readHandle={window.zenx.plugins.readHandle}
          />
        </section>
      ) : show("lineage") ? (
        <p role="status">{t("unavailable")}</p>
      ) : null}
      {show("shell") ? (
        <section
          className="conversation-information-section"
          aria-label={t("backgroundShellTitle")}
        >
          {!embedded && (
            <header>
              <h3>
                <Icon name="terminal" size={15} />
                {t("backgroundShellTitle")}
              </h3>
            </header>
          )}
          <BackgroundShellStatus
            threadId={threadId}
            presentation="information"
          />
        </section>
      ) : null}
    </div>
  );
}

const MemoizedConversationInformationContent = memo(
  ConversationInformationContent,
);

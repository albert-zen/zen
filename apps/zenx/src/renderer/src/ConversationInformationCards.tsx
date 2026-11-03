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

type ConversationInformationProps = {
  threadId: string;
  threads: readonly NativeThreadSummary[];
  snapshot: ZenXPluginSnapshot;
  registry: PluginUiRegistry;
  theme: "light" | "dark";
  navigate(route: string): void;
  /** Dedicated question UI never shares Board fields or main Composer state. */
  attention?: ReactNode;
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
      {...props}
      navigate={navigateLatest}
    />
  );
}

/** Read-only projections; canonical summary/admission/attention changes still render. */
function ConversationInformationContent({
  threadId,
  threads,
  snapshot,
  registry,
  theme,
  navigate,
  attention,
}: ConversationInformationProps) {
  const { t } = useTranslation("panels");
  const lineageContext = useMemo(
    () => ({ threadId, threads }),
    [threadId, threads],
  );
  const admissionId = sidebarTriggerAdmissionId(snapshot);
  const { state, refresh } = useSidebarTriggers(admissionId, threadId);
  const triggers = state.triggers.filter(
    (trigger) => trigger.threadId === threadId,
  );
  const subagents = snapshot.panels.find(
    (panel) => panel.pluginId === "zenx-subagents",
  );
  const [busyTrigger, setBusyTrigger] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const setTriggerActive = async (trigger: SidebarTrigger, next: boolean) => {
    if (busyTrigger !== null) return;
    setBusyTrigger(trigger.id);
    setTriggerError(null);
    try {
      await window.zenx.plugins.executeCommand(
        "zenx-triggers",
        next ? "resume" : "cancel",
        next
          ? {
              triggerId: trigger.id,
              expectedRevision: trigger.definitionRevision ?? 0,
            }
          : { triggerId: trigger.id },
      );
      await refresh(true);
    } catch {
      setTriggerError(t("triggerToggleFailed"));
      // Reconcile a stale revision or a concurrent edit instead of leaving a
      // switch that no longer matches the Host definition.
      await refresh(true);
    } finally {
      setBusyTrigger(null);
    }
  };
  return (
    <div className="conversation-information-cards">
      {attention}
      <section
        className="conversation-information-section"
        aria-label={t("threadTriggers")}
      >
        <header>
          <h3>
            <Icon name="clock" size={15} />
            {t("threadTriggers")}
          </h3>
          {admissionId ? (
            <button
              type="button"
              className="icon-button"
              aria-label={t("refresh")}
              title={t("refresh")}
              onClick={() => void refresh(true)}
            >
              <Icon name="reload" size={14} />
            </button>
          ) : null}
        </header>
        {state.status !== "ready" ? (
          <p role="status">
            {state.status === "loading" ? t("boardLoading") : t("unavailable")}
          </p>
        ) : triggers.length ? (
          <>
            <ul className="information-trigger-list">
            {triggers.map((trigger) => {
              const label = trigger.label ?? trigger.id;
              const busy = busyTrigger === trigger.id;
              return (
                <li key={trigger.id}>
                  <span className="information-trigger-main">
                    <strong title={label}>{label}</strong>
                    <small>{t(trigger.active ? "enabled" : "paused")}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={trigger.active}
                    aria-busy={busy}
                    aria-label={`${t(trigger.active ? "pauseTrigger" : "enableTrigger")} · ${label}`}
                    title={t(trigger.active ? "pauseTrigger" : "enableTrigger")}
                    className="plugin-switch"
                    disabled={busy}
                    onClick={() => void setTriggerActive(trigger, !trigger.active)}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    title={t("edit")}
                    aria-label={`${t("edit")} · ${label}`}
                    onClick={() => navigate(triggerSourceRoute(trigger.id))}
                  >
                    <Icon name="compose" size={15} />
                  </button>
                </li>
              );
            })}
            </ul>
            {triggerError ? (
              <p className="information-trigger-error" role="alert">
                {triggerError}
              </p>
            ) : null}
          </>
        ) : (
          <p>{t("informationNoTriggers")}</p>
        )}
      </section>
      {subagents ? (
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
      ) : null}
      <section
        className="conversation-information-section"
        aria-label={t("backgroundShellTitle")}
      >
        <header>
          <h3>
            <Icon name="terminal" size={15} />
            {t("backgroundShellTitle")}
          </h3>
        </header>
        <BackgroundShellStatus threadId={threadId} presentation="information" />
      </section>
    </div>
  );
}

const MemoizedConversationInformationContent = memo(
  ConversationInformationContent,
);

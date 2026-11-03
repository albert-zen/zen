import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
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
} from "./sidebar-thread-information.js";
import { triggerSourceRoute } from "./message-source-navigation.js";
import { Icon } from "./icons.js";
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
  const { state, refresh } = useSidebarTriggers(admissionId, threadId);
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
              {state.status === "loading"
                ? t("boardLoading")
                : t("unavailable")}
            </p>
          ) : triggers.length ? (
            <ul className="information-trigger-list">
              {triggers.map((trigger) => (
                <li key={trigger.id}>
                  <span>
                    <strong title={trigger.label ?? trigger.id}>
                      {trigger.label ?? trigger.id}
                    </strong>
                    <small>{t(trigger.active ? "enabled" : "paused")}</small>
                  </span>
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

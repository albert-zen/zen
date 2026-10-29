import React, { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ShellSessionSummary } from "../../../../../src/shell-session.js";
import {
  shellListing,
  backgroundShellPhase,
} from "./background-shell-state.js";
import { ShellTargetNavigationContext } from "./shell-target-navigation.js";
import { Icon } from "./icons.js";

export function BackgroundShellStatus({ threadId }: { threadId: string }) {
  const { t } = useTranslation("panels");
  const navigation = useContext(ShellTargetNavigationContext);
  const api =
    typeof window === "undefined" ? undefined : window.zenx?.shellPanel;
  const [observation, setObservation] = useState<{
    threadId: string;
    sessions: ShellSessionSummary[];
    error: string | null;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const identity = useRef(threadId);
  identity.current = threadId;
  const mounted = useRef(true);
  const openingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setExpanded(false);
    setNavigationError("");
    setOpening(null);
    openingRef.current = false;
  }, [threadId]);
  useEffect(() => {
    if (!api) return;
    let retired = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = shellListing(
          await api.request({ operation: "list", threadId }),
          threadId,
        );
        if (!retired)
          setObservation({
            threadId,
            sessions: result.sessions.filter(
              (s) => s.origin === "agent" && s.kind === "command",
            ),
            error: null,
          });
      } catch (error) {
        if (!retired)
          setObservation({ threadId, sessions: [], error: String(error) });
      } finally {
        if (!retired) timer = setTimeout(() => void read(), 1000);
      }
    };
    void read();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [threadId, api, refresh]);
  const current = observation?.threadId === threadId ? observation : null;
  if (!api || !current) return null;
  const pending = current.sessions.filter(
    (s) => backgroundShellPhase(s) !== "ended",
  );
  const running = pending.filter(
    (s) => backgroundShellPhase(s) === "running",
  ).length;
  if (!current.error && !pending.length && !expanded) return null;
  const otherPhases = (
    ["starting", "queued", "output", "stopping", "unconfirmed"] as const
  )
    .map((phase) => ({
      phase,
      count: pending.filter(
        (session) => backgroundShellPhase(session) === phase,
      ).length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ phase, count }) => t(`backgroundShellCount_${phase}`, { count }))
    .join(" · ");
  const phaseLabel = (session: ShellSessionSummary) => {
    const phase = backgroundShellPhase(session);
    return phase === "ended"
      ? t(`shellStatus_${session.status}`)
      : t(`backgroundShellPhase_${phase}`);
  };
  const open = async (session: ShellSessionSummary) => {
    if (!navigation || openingRef.current) return;
    openingRef.current = true;
    setOpening(session.taskId);
    setNavigationError("");
    const ownerThreadId = threadId;
    const isCurrent = () =>
      mounted.current && identity.current === ownerThreadId;
    try {
      await navigation.open(
        { threadId, taskId: session.taskId },
        { isCurrent },
      );
    } catch (error) {
      if (isCurrent()) setNavigationError(String(error));
    } finally {
      if (isCurrent()) {
        openingRef.current = false;
        setOpening(null);
      }
    }
  };
  return (
    <section
      className="background-shell-status"
      aria-label={t("backgroundShellTitle")}
    >
      <div className="background-shell-heading">
        <button
          type="button"
          className="background-shell-disclosure"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="terminal" size={14} />
          <span aria-live="polite">
            {current.error
              ? t("backgroundShellReadFailed")
              : running
                ? t("backgroundShellRunning", { count: running })
                : pending.length
                  ? otherPhases
                  : t("backgroundShellNone")}
          </span>
          {!current.error && running > 0 && pending.length > running ? (
            <span>· {otherPhases}</span>
          ) : null}
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("backgroundShellRefresh")}
        </button>
      </div>
      {current.error ? (
        <details className="background-shell-error">
          <summary>{t("backgroundShellErrorDetails")}</summary>
          <pre>{current.error}</pre>
        </details>
      ) : null}
      {expanded && !current.error ? (
        <ul className="background-shell-list">
          {current.sessions.map((session) => (
            <li key={session.taskId}>
              <button
                type="button"
                disabled={!navigation || opening !== null}
                onClick={() => void open(session)}
                title={t("backgroundShellOpen", { command: session.command })}
              >
                <code>{session.command}</code>
                <span>
                  {phaseLabel(session)}
                  {session.exitCode !== null
                    ? ` · ${t("shellExitCode", { code: session.exitCode })}`
                    : ""}
                </span>
                <Icon name="arrow-right" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {navigationError ? (
        <details open className="background-shell-error">
          <summary>{t("backgroundShellOpenFailed")}</summary>
          <pre>{navigationError}</pre>
        </details>
      ) : null}
    </section>
  );
}

import React, { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ShellSessionSummary } from "../../../../../src/shell-session.js";
import {
  shellListing,
  backgroundShellPhase,
} from "./background-shell-state.js";
import { ShellTargetNavigationContext } from "./shell-target-navigation.js";
import { Icon } from "./icons.js";

export function BackgroundShellStatus({
  threadId,
  presentation = "compact",
  onVisibilityChange,
  manageMode = false,
}: {
  threadId: string;
  presentation?: "compact" | "information";
  onVisibilityChange?: (visible: boolean) => void;
  manageMode?: boolean;
}) {
  const { t } = useTranslation("panels");
  const navigation = useContext(ShellTargetNavigationContext);
  const api =
    typeof window === "undefined" ? undefined : window.zenx?.shellPanel;
  const [observation, setObservation] = useState<{
    threadId: string;
    sessions: ShellSessionSummary[];
    error: string | null;
  } | null>(null);
  const [expanded, setExpanded] = useState(presentation === "information");
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
    setExpanded(presentation === "information");
    setNavigationError("");
    setOpening(null);
    openingRef.current = false;
  }, [threadId, presentation]);
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
          setObservation((previous) => ({
            threadId,
            sessions: previous?.threadId === threadId ? previous.sessions : [],
            error: String(error),
          }));
      } finally {
        if (!retired) timer = setTimeout(() => void read(), 1000);
      }
    };
    void read();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [threadId, api]);
  const current = observation?.threadId === threadId ? observation : null;
  const pending = (current?.sessions ?? []).filter(
    (s) => backgroundShellPhase(s) !== "ended",
  );
  const visible = !!api && pending.length > 0;
  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [onVisibilityChange, visible]);
  if (
    !visible &&
    !manageMode &&
    !(presentation === "compact" && current?.error)
  )
    return null;
  if (!api || !current)
    return <p role="status">{t(!api ? "unavailable" : "boardLoading")}</p>;
  // A background command surface is live work only. Ended commands are
  // history; keeping one beside "no commands running" is never meaningful.
  const listed = pending;
  const running = pending.filter(
    (s) => backgroundShellPhase(s) === "running",
  ).length;
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
      </div>
      {current.error ? (
        <details className="background-shell-error">
          <summary>{t("backgroundShellErrorDetails")}</summary>
          <pre>{current.error}</pre>
        </details>
      ) : null}
      {expanded && listed.length > 0 ? (
        <ul className="background-shell-list">
          {listed.map((session) => (
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

/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Terminal } from "@xterm/xterm";
import type {
  ShellSessionRead,
  ShellSessionSummary,
} from "../../../../../src/shell-session.js";
import type { ShellPanelListing } from "../../shell-panel.js";
import { Icon } from "./icons.js";
import { restrictTerminalOutput } from "./shell-terminal-security.js";

const ended = (status: ShellSessionSummary["status"]) =>
  ["completed", "failed", "cancelled", "timed_out"].includes(status);

export function ShellThreadPanel({
  threadId,
  active,
}: {
  threadId: string;
  active: boolean;
}) {
  const { t } = useTranslation("panels");
  const api = window.zenx.shellPanel;
  const [listing, setListing] = useState<ShellPanelListing | null>(null);
  const [selected, setSelected] = useState<ShellSessionSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const epoch = useRef(0);
  const mutationBusy = useRef(false);
  const viewEpoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    mutationBusy.current = false;
    viewEpoch.current++;
    setListing(null);
    setSelected(null);
    setError("");
    setBusy(false);
    setStopConfirm(false);
    return () => {
      if (epoch.current === generation) epoch.current++;
    };
  }, [threadId]);
  useEffect(() => {
    if (!active || !api) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = (await api.request({
          operation: "list",
          threadId,
        })) as ShellPanelListing;
        if (cancelled) return;
        setListing(result);
        setSelected((previous) =>
          previous
            ? (result.sessions.find((s) => s.taskId === previous.taskId) ??
              previous)
            : null,
        );
      } catch (e) {
        if (!cancelled) {
          setListing(null);
          setError(String(e));
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [threadId, active, api]);
  const create = async () => {
    if (!api || mutationBusy.current || !listing?.canCreate) return;
    const generation = epoch.current;
    const selection = viewEpoch.current;
    mutationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      const session = (await api.request({
        operation: "create",
        threadId,
        cols: 80,
        rows: 24,
      })) as ShellSessionSummary;
      if (generation === epoch.current) {
        setListing((old) =>
          old
            ? {
                ...old,
                sessions: [
                  session,
                  ...old.sessions.filter((s) => s.taskId !== session.taskId),
                ],
              }
            : old,
        );
        if (selection === viewEpoch.current) setSelected(session);
      }
    } catch (e) {
      if (generation === epoch.current) setError(String(e));
    } finally {
      if (generation === epoch.current) {
        mutationBusy.current = false;
        setBusy(false);
      }
    }
  };
  const stop = async () => {
    if (!api || !selected || mutationBusy.current) return;
    const generation = epoch.current;
    const id = selected.taskId;
    mutationBusy.current = true;
    setBusy(true);
    setError("");
    setStopConfirm(false);
    try {
      const result = (await api.request({
        operation: "stop",
        threadId,
        taskId: id,
      })) as ShellSessionSummary;
      if (generation === epoch.current)
        setSelected((current) => (current?.taskId === id ? result : current));
    } catch (e) {
      if (generation === epoch.current) setError(String(e));
    } finally {
      if (generation === epoch.current) {
        mutationBusy.current = false;
        setBusy(false);
      }
    }
  };
  const statusText = (session: ShellSessionSummary) =>
    t(`shellStatus_${session.status}`);
  return (
    <section className="shell-panel" aria-label={t("shellTitle")}>
      <header className="shell-panel-heading">
        {selected ? (
          <button
            type="button"
            className="secondary-button shell-back"
            aria-label={t("shellSessions")}
            title={t("shellSessions")}
            onClick={() => {
              viewEpoch.current++;
              setSelected(null);
              setStopConfirm(false);
            }}
          >
            <Icon name="arrow-left" />
          </button>
        ) : null}
        <div className="shell-heading-context">
          {selected ? (
            <strong
              title={
                selected.kind === "terminal"
                  ? t("shellInteractive")
                  : selected.command
              }
            >
              {selected.kind === "terminal"
                ? t("shellInteractive")
                : selected.command}
            </strong>
          ) : (
            <span className="shell-eyebrow">{t("shellLocalHost")}</span>
          )}
          <span
            className="shell-directory"
            title={selected?.cwd ?? listing?.cwd}
          >
            {selected?.cwd ?? listing?.cwd ?? t("shellLoading")}
          </span>
        </div>
        {selected ? (
          <span className="shell-status" data-status={selected.status}>
            {listing?.sessions.some((s) => s.taskId === selected.taskId)
              ? statusText(selected)
              : t("shellStatus_unknown")}
          </span>
        ) : null}
        <button
          type="button"
          className="secondary-button shell-new"
          disabled={!api || busy || !listing?.canCreate}
          onClick={() => void create()}
          title={t("shellCreationContext")}
          aria-label={t("shellNew")}
        >
          <Icon name="plus" />
          <span>{t("shellNew")}</span>
        </button>
        {selected && !ended(selected.status) ? (
          <button
            type="button"
            className="secondary-button shell-stop"
            aria-label={t("shellStop")}
            title={t("shellStop")}
            disabled={
              busy ||
              !listing?.sessions.some((s) => s.taskId === selected.taskId)
            }
            onClick={() => setStopConfirm(true)}
          >
            <Icon name="stop" />
          </button>
        ) : null}
      </header>
      {!api ? <p role="status">{t("shellUnavailable")}</p> : null}
      {listing?.restriction ? (
        <p className="shell-notice">
          {t(
            listing.restriction === "archived"
              ? "shellArchived"
              : "shellSandbox",
          )}
        </p>
      ) : null}
      {error ? (
        <p className="shell-error" role="alert">
          {error}
        </p>
      ) : null}
      {selected ? (
        <>
          <details className="shell-details shell-session-details">
            <summary>{t("shellSessionDetails")}</summary>
            <div className="shell-session-identity">
              <p>
                {t(
                  selected.origin === "user"
                    ? "shellOriginUser"
                    : "shellOriginAgent",
                )}
              </p>
              <p>
                <code>{selected.command}</code>
              </p>
              <p>
                <code>{selected.cwd}</code>
              </p>
              <p>
                {t("shellTaskId")}: <code>{selected.taskId}</code>
              </p>
            </div>
          </details>
          {stopConfirm ? (
            <div
              className="shell-stop-confirm"
              role="alertdialog"
              aria-label={t("shellStopQuestion")}
            >
              <p>{t("shellStopQuestion")}</p>
              <p>{t("shellStopDetail")}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStopConfirm(false)}
              >
                {t("shellCancel")}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void stop()}
              >
                {t("shellStop")}
              </button>
            </div>
          ) : null}
          {selected.lifecycle?.foreground === "exited" &&
          !ended(selected.status) ? (
            <p className="shell-notice">
              {t("shellForegroundExited", {
                code: selected.lifecycle.foreground_exit_code ?? "signal",
              })}
            </p>
          ) : null}
          {selected.exitCode !== null ? (
            <p className="shell-exit">
              {t("shellExitCode", { code: selected.exitCode })}
            </p>
          ) : null}
          <ShellTerminal
            key={`${threadId}:${selected.taskId}`}
            threadId={threadId}
            session={selected}
            active={active}
            onError={setError}
          />
        </>
      ) : (
        <div className="shell-session-list">
          {listing && listing.sessions.length === 0 ? (
            <div className="shell-empty">
              <Icon name="terminal" />
              <h4>{t("shellEmpty")}</h4>
              <p>{t("shellEmptyDetail")}</p>
            </div>
          ) : null}
          {listing?.sessions.map((session) => (
            <button
              className="shell-session-card"
              type="button"
              key={session.taskId}
              onClick={() => {
                viewEpoch.current++;
                setSelected(session);
                setStopConfirm(false);
                setError("");
              }}
            >
              <Icon name="terminal" />
              <span className="shell-card-body">
                <strong title={session.command}>
                  {session.kind === "terminal"
                    ? t("shellInteractive")
                    : session.command}
                </strong>
                <small>
                  {t(
                    session.origin === "user"
                      ? "shellOriginUser"
                      : "shellOriginAgent",
                  )}{" "}
                  · {session.cwd}
                </small>
              </span>
              <span className="shell-status" data-status={session.status}>
                {statusText(session)}
              </span>
            </button>
          ))}
        </div>
      )}
      <footer className="shell-lifetime">
        {selected ? (
          <p className="shell-footnote shell-input-mode">
            {t(
              selected.origin === "user"
                ? "shellUserInput"
                : "shellAgentReadOnly",
            )}
          </p>
        ) : null}
        <p className="shell-footnote">{t("shellCloseHint")}</p>
        <details className="shell-details">
          <summary>{t("shellSessionHelp")}</summary>
          <p>{t("shellCreationContext")}</p>
          <p>{t("shellLifetime")}</p>
        </details>
      </footer>
    </section>
  );
}

function ShellTerminal({
  threadId,
  session,
  active,
  onError,
}: {
  threadId: string;
  session: ShellSessionSummary;
  active: boolean;
  onError(message: string): void;
}) {
  const { t } = useTranslation("panels");
  const element = useRef<HTMLIFrameElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const input = useRef(false);
  const visible = useRef(active);
  const [truncated, setTruncated] = useState(false);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    visible.current = active;
    input.current = active && session.inputAvailable;
    if (terminal.current)
      terminal.current.options.disableStdin = !input.current;
  }, [active, session.inputAvailable]);
  useEffect(() => {
    const api = window.zenx.shellPanel;
    if (!api || !element.current) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let term: Terminal | undefined;
    let resize: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let cursor = 0;
    let pending = "";
    let writing = false;
    const flush = async () => {
      if (writing || !pending || disposed) return;
      writing = true;
      const data = pending;
      pending = "";
      try {
        await api.request({
          operation: "write",
          threadId,
          taskId: session.taskId,
          data,
        });
      } catch (e) {
        pending = "";
        input.current = false;
        if (!disposed) onError(`${t("shellInputUnconfirmed")} ${String(e)}`);
      } finally {
        writing = false;
        if (!disposed && input.current) void flush();
      }
    };
    const setup = async () => {
      const [{ Terminal }, { FitAddon }, { default: terminalCss }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/xterm/css/xterm.css?inline"),
        ]);
      if (disposed || !element.current) return;
      const frame = element.current;
      const frameUrl = new URL("./terminal-frame.html", document.baseURI).href;
      if (
        frame.contentDocument?.URL !== frameUrl ||
        frame.contentDocument.readyState !== "complete"
      )
        await new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
      if (disposed || !frame.contentDocument) return;
      const terminalDocument = frame.contentDocument;
      if (
        terminalDocument.URL !== frameUrl ||
        terminalDocument
          .querySelector('meta[name="zenx-shell-surface"]')
          ?.getAttribute("content") !== "v1"
      )
        throw new Error("Unexpected terminal surface; input is disabled");
      // FitAddon subtracts padding on the xterm element, not its parent.
      // Keep the body unpadded so the fitted rows and columns remain visible.
      const style = terminalDocument.createElement("style");
      style.textContent =
        terminalCss +
        "html,body{height:100%;margin:0;overflow:hidden;background:var(--color-surface-control)}body{padding:0}.xterm{height:100%;box-sizing:border-box;padding:10px}";
      terminalDocument.head.append(style);
      term = new Terminal({
        documentOverride: terminalDocument,
        cols: 80,
        rows: 24,
        convertEol: session.kind === "command",
        disableStdin: !input.current,
        scrollback: 3000,
        screenReaderMode: true,
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      });
      terminal.current = term;
      const applyTheme = () => {
        if (!term || disposed) return;
        const computed = window.getComputedStyle(document.documentElement);
        const color = (name: string) => computed.getPropertyValue(name).trim();
        const background = color("--color-surface-control");
        terminalDocument.documentElement.style.setProperty(
          "--color-surface-control",
          background,
        );
        term.options.theme = {
          background,
          foreground: color("--color-text-primary"),
          cursor: color("--color-accent"),
          // xterm6 rejects translucent CSS4 token strings. Use the canonical
          // opaque accent pair so selection stays legible in both app modes.
          selectionBackground: color("--color-accent"),
          selectionForeground: color("--color-text-on-accent"),
        };
      };
      applyTheme();
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, { attributes: true });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(terminalDocument.body);
      // No links, clipboard, title, command-detection or shell-integration hooks.
      // Escape sequences only render terminal data; they cannot call app actions.
      restrictTerminalOutput(term);
      term.onData((data) => {
        if (!input.current || disposed) return;
        if (pending.length + data.length > 16384) {
          onError(t("shellInputTooLarge"));
          return;
        }
        pending += data;
        void flush();
      });
      term.onScroll(() => {
        if (term)
          setFollowing(
            term.buffer.active.viewportY >= term.buffer.active.baseY,
          );
      });
      let lastSize = "";
      const measure = () => {
        if (
          !term ||
          disposed ||
          !visible.current ||
          !element.current?.clientWidth ||
          !element.current.clientHeight
        )
          return;
        fit.fit();
        const cols = Math.min(500, Math.max(1, term.cols));
        const rows = Math.min(200, Math.max(1, term.rows));
        const size = `${cols}:${rows}`;
        if (input.current && size !== lastSize) {
          lastSize = size;
          void api
            .request({
              operation: "resize",
              threadId,
              taskId: session.taskId,
              cols,
              rows,
            })
            .catch((e) => {
              if (!disposed) onError(String(e));
            });
        }
      };
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(measure);
        resize.observe(element.current);
      }
      measure();
      const read = async () => {
        if (!visible.current) {
          if (!disposed) timer = setTimeout(() => void read(), 250);
          return;
        }
        try {
          const result = (await api.request({
            operation: "read",
            threadId,
            taskId: session.taskId,
            cursor,
          })) as ShellSessionRead;
          if (disposed || !term) return;
          input.current = visible.current && result.session.inputAvailable;
          term.options.disableStdin = !input.current;
          if (result.truncated) {
            setTruncated(true);
            term.reset();
          }
          if (result.output)
            await new Promise<void>((resolve) =>
              term!.write(result.output, resolve),
            );
          cursor = result.cursor;
          measure();
        } catch (e) {
          input.current = false;
          if (!disposed) {
            if (term) term.options.disableStdin = true;
            onError(`${t("shellObservationUnknown")} ${String(e)}`);
          }
        } finally {
          if (!disposed) timer = setTimeout(() => void read(), 250);
        }
      };
      void read();
    };
    void setup().catch((e) => {
      if (!disposed) onError(String(e));
    });
    return () => {
      disposed = true;
      input.current = false;
      clearTimeout(timer);
      resize?.disconnect();
      themeObserver?.disconnect();
      term?.dispose();
      terminal.current = null;
    };
  }, [threadId, session.taskId, session.kind, onError, t]);
  return (
    <div className="shell-terminal-wrap">
      {truncated ? <p className="shell-notice">{t("shellTruncated")}</p> : null}
      <iframe
        className="shell-terminal"
        ref={element}
        title={t("shellOutput")}
        sandbox="allow-same-origin"
        src="./terminal-frame.html"
      />
      {!following ? (
        <button
          type="button"
          className="secondary-button shell-follow"
          onClick={() => {
            terminal.current?.scrollToBottom();
            setFollowing(true);
          }}
        >
          {t("shellFollow")}
        </button>
      ) : null}
    </div>
  );
}

// xterm's dimension/theme rules require generated styles. A separate packaged,
// scriptless page owns that narrow style policy; srcdoc would inherit the
// parent's strict CSP and cannot relax it. No postMessage bridge is exposed.

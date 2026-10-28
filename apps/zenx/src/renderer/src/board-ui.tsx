import { useTranslation } from "react-i18next";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  BoardBlock,
  BoardValues,
} from "../../../../../packages/zenx-board-plugin/src/board.js";
import {
  IsolatedPluginSurface,
  type PluginUiRegistry,
  type PluginUiSurfaceProps,
} from "./plugin-ui-host.js";
import {
  BoardUiSession,
  conversationKey,
  message,
  type BoardConversation,
} from "./board-ui-state.js";
import { Select } from "./ui/controls.js";
import { Icon } from "./icons.js";

const sessions = new Map<string, BoardUiSession>();
export function registerBoardUi(registry: PluginUiRegistry) {
  registry.registerTrusted("zenx/bundled/board-ui", { board: BoardSurface });
}
export function BoardSurface({ sdk }: PluginUiSurfaceProps) {
  const { t } = useTranslation("panels");
  const owner = sdk.context.owner as BoardConversation;
  const key = `${String(sdk.context.admissionId ?? "fixture")}:${conversationKey(owner)}`;
  const commands = useRef(sdk.commands);
  commands.current = sdk.commands;
  const session = useMemo(() => {
    let current = sessions.get(key);
    if (!current) {
      current = new BoardUiSession(owner, (input) =>
        commands.current.execute("ui", input),
      );
      sessions.set(key, current);
    }
    return current;
  }, [key]);
  const [, render] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(
    () => session.subscribe(() => render((value) => value + 1)),
    [session],
  );
  useEffect(() => {
    void session.refresh();
    const timer = setInterval(() => {
      if (!document.hidden && !session.busy) void session.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [session]);
  const active = useRef({ key, mounted: true });
  active.current.key = key;
  useEffect(() => {
    active.current.mounted = true;
    return () => {
      active.current.mounted = false;
    };
  }, [key]);
  const run = async (id: string, values?: BoardValues) => {
    const revision = session.snapshot?.revision;
    setLocalError(null);
    try {
      const result = await session.run(id, values);
      if (
        active.current.mounted &&
        active.current.key === key &&
        session.snapshot?.revision === revision
      )
        for (const route of result.navigation) sdk.navigation.navigate(route);
      return result;
    } catch (error) {
      if (active.current.mounted && active.current.key === key)
        setLocalError(message(error));
      throw error;
    }
  };
  const customSdk = useMemo(
    () => ({
      ...sdk,
      context: { board: session.snapshot?.document, values: session.values },
      commands: {
        execute: async (command: string, input?: unknown) => {
          if (command === "draft") {
            if (
              typeof input !== "object" ||
              input === null ||
              Array.isArray(input)
            )
              throw new Error("draft requires field values");
            session.edit(input as BoardValues);
            await session.flush();
            return { saved: true };
          }
          if (command === "event") {
            const id = (input as { eventId?: unknown })?.eventId;
            if (
              typeof id !== "string" ||
              !session.snapshot?.document.events.some(
                (event) => event.id === id,
              )
            )
              throw new Error("Unknown Board event");
            return await run(id, (input as { values?: BoardValues }).values);
          }
          throw new Error(
            "Custom Board content may only save fields or request a declared event",
          );
        },
      },
    }),
    [sdk, session, session.snapshot, session.values],
  );
  if (session.loading && !session.snapshot)
    return (
      <p role="status" className="board-empty">
        {t("boardLoading")}
      </p>
    );
  if (!session.snapshot)
    return (
      <div className="board-empty">
        <Icon name="list-detail" size={24} />
        <h3>{t("boardEmptyTitle")}</h3>
        <p>{t("boardEmptyDescription")}</p>
        {session.error ? <p role="alert">{session.error}</p> : null}
        <button type="button" onClick={() => void session.refresh()}>
          {t("boardRefreshContent")}
        </button>
      </div>
    );
  const board = session.snapshot.document;
  return (
    <div className="board-surface">
      <header className="board-heading">
        <span className="board-eyebrow">{t("boardEyebrow")}</span>
        <h2>{board.title}</h2>
        <p>{board.summary}</p>
        <small>
          {board.owner.kind === "room"
            ? t("boardRoomOwner")
            : t("boardThreadOwner")}{" "}
          · <code>{board.id}</code>
        </small>
      </header>
      {board.blocks.map((block) => (
        <BoardBlockView
          key={block.id}
          block={block}
          values={session.values}
          busy={session.busy}
          edit={(value) => session.edit(value)}
          run={(id) => void run(id).catch(() => {})}
        />
      ))}
      {board.html ? (
        <IsolatedPluginSurface
          className="board-custom"
          bundleHtml={board.html}
          exportName="board"
          sdk={customSdk}
          requireUserActivationFor={["event", "draft"]}
          interactionScope={`${key}:${session.snapshot.revision}`}
        />
      ) : null}
      {session.error || localError ? (
        <div role="alert" className="board-error">
          <p>{session.error ?? localError}</p>
          {session.dirty ? (
            <button
              type="button"
              onClick={() =>
                void session
                  .discardLocalDraft()
                  .catch((error) => setLocalError(message(error)))
              }
            >
              {t("boardDiscardLocal")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              void session.refresh();
            }}
          >
            {t("boardRefreshContent")}
          </button>
        </div>
      ) : null}
      {session.result ? (
        <p role="status" className="board-result">
          {session.result.error
            ? t("boardStopped")
            : session.result.outcomes.some((item) => item.kind === "submit")
              ? t("boardSent")
              : t("boardDone")}
        </p>
      ) : null}
      {session.result?.outcomes.some((item) => item.result !== undefined) ? (
        <details className="board-outcomes">
          <summary>{t("boardDetails")}</summary>
          {session.result.outcomes.map((item, index) =>
            item.result === undefined ? null : (
              <pre key={index}>
                {JSON.stringify(item.result, null, 2).slice(0, 32000)}
              </pre>
            ),
          )}
        </details>
      ) : null}
      <footer className="board-footer">
        <span>
          {session.busy
            ? t("boardWorking")
            : session.dirty
              ? t("boardUnsaved")
              : t("boardSaved")}
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label={t("boardRefreshLabel")}
          title={t("boardRefreshLabel")}
          onClick={() => void session.refresh()}
        >
          <Icon name="reload" size={14} />
        </button>
      </footer>
    </div>
  );
}
function BoardBlockView({
  block,
  values,
  busy,
  edit,
  run,
}: {
  block: BoardBlock;
  values: BoardValues;
  busy: boolean;
  edit(values: BoardValues): void;
  run(id: string): void;
}) {
  switch (block.kind) {
    case "note":
      return (
        <section className="board-note">
          {block.title ? <h3>{block.title}</h3> : null}
          <p>{block.text}</p>
        </section>
      );
    case "metric":
      return (
        <section className="board-metric">
          <span>{block.title}</span>
          <strong>{block.value}</strong>
          {block.detail ? <small>{block.detail}</small> : null}
        </section>
      );
    case "progress":
      return (
        <section className="board-progress">
          <div>
            <span>{block.title}</span>
            <small>
              {block.value} / {block.max ?? 100}
            </small>
          </div>
          <progress value={block.value} max={block.max ?? 100} />
        </section>
      );
    case "action":
      return (
        <button
          className={`board-action${block.emphasis ? " primary" : ""}`}
          type="button"
          disabled={busy}
          onClick={() => run(block.event)}
        >
          {block.label}
          <Icon name="arrow-right" size={14} />
        </button>
      );
    case "field": {
      const value = values[block.field];
      return (
        <label
          className={`board-field${block.input === "checkbox" ? " checkbox" : ""}`}
        >
          <span>{block.label}</span>
          {block.input === "checkbox" ? (
            <input
              type="checkbox"
              checked={value === true}
              onChange={(event) =>
                edit({ [block.field]: event.currentTarget.checked })
              }
            />
          ) : block.input === "select" ? (
            <Select
              value={String(value ?? "")}
              onValueChange={(value) => edit({ [block.field]: value })}
              aria-label={block.label}
            >
              {(block.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          ) : block.input === "textarea" ? (
            <textarea
              value={String(value ?? "")}
              placeholder={block.placeholder}
              onChange={(event) =>
                edit({ [block.field]: event.currentTarget.value })
              }
            />
          ) : (
            <input
              value={String(value ?? "")}
              placeholder={block.placeholder}
              onChange={(event) =>
                edit({ [block.field]: event.currentTarget.value })
              }
            />
          )}
        </label>
      );
    }
  }
}

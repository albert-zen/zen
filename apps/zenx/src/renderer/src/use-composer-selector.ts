import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import type { SkillEntry } from "../../../../cli/src/skills.js";
import {
  commandCandidates,
  expandWorkflowCommand,
  type WorkflowCommand,
  type WorkflowCommandCandidate,
} from "./workflow-commands.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";
import { isCompactCommand } from "./compact-command.js";
import {
  replaceTrigger,
  selectorTrigger,
  type Reference,
} from "./composer-selector.js";

export interface SelectorCandidate {
  key: string;
  kind: "built-in" | "custom" | "skill" | "file" | "thread" | "more";
  name: string;
  description: string;
  detail?: string;
  command?: WorkflowCommandCandidate;
  reference?: Reference;
  generatedUntitled?: boolean;
  threadStatus?: "active" | "idle";
  duplicateThreadId?: string;
}

type SelectorNote =
  | { key: "fileSearchPartial" | "workspaceFilesAfterCreation" }
  | { text: string };
type SelectorError =
  | {
      key: "filesError" | "threadsError" | "couldNotSelectReference";
      error: string;
    }
  | { text: string };

export function useComposerSelector({
  draft,
  threadId,
  commands,
  skills,
  onChange,
  textarea,
}: {
  draft: string;
  threadId?: string;
  commands: readonly WorkflowCommand[];
  skills: readonly SkillEntry[];
  onChange(text: string): void;
  textarea: React.RefObject<HTMLTextAreaElement | null>;
}) {
  useTranslation("selector");
  const parsed = parseSkillDraft(draft);
  const [selection, setSelection] = useState<{
    text: string;
    start: number;
    end: number;
  } | null>(null);
  const start =
    selection?.text === parsed.text ? selection.start : parsed.text.length;
  const end = selection?.text === parsed.text ? selection.end : start;
  const trigger = selectorTrigger(parsed.text, start, end);
  // Preserve slash commands with arguments, including the existing compact path.
  const commandInput =
    trigger?.kind === "command" ? `/${trigger.query}` : parsed.text;
  const slash =
    trigger?.kind === "command" ||
    (start === parsed.text.length && parsed.text.startsWith("/"));
  const scope = `${threadId ?? "draft"}\0${draft}\0${start}\0${end}`;
  const current = useRef(scope);
  current.current = scope;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [limit, setLimit] = useState(40);
  const [result, setResult] = useState<{
    scope: string;
    rows: SelectorCandidate[];
    loading: boolean;
    notes: SelectorNote[];
    errors: SelectorError[];
  }>({ scope: "", rows: [], loading: false, notes: [], errors: [] });
  const [choosing, setChoosing] = useState<string | null>(null);
  const referenceMode = trigger?.kind === "reference";
  const open =
    dismissed !== scope &&
    (referenceMode || (slash && !isCompactCommand(commandInput)));
  const query = trigger?.query ?? "";
  useEffect(() => {
    setActive(0);
    setLimit(40);
  }, [scope]);
  useEffect(() => {
    if (!referenceMode || !open) return;
    let canceled = false;
    setResult({ scope, rows: [], loading: true, notes: [], errors: [] });
    const timer = setTimeout(() => {
      void (async () => {
        const rows: SelectorCandidate[] = [];
        const errors: SelectorError[] = [];
        const notes: SelectorNote[] = [];
        const [files, threads] = await Promise.allSettled([
          threadId
            ? window.zenx.workspaceFiles.search(threadId, query)
            : Promise.resolve(null),
          window.zenx.threads.list(),
        ]);
        if (canceled || current.current !== scope) return;
        if (files.status === "fulfilled" && files.value) {
          const value = files.value;
          for (const file of value.entries)
            rows.push({
              key: `file:${file.path}`,
              kind: "file",
              name: file.name,
              description: file.path,
              reference: {
                kind: "file",
                name: file.name,
                path: file.path,
                cwd: value.cwd,
              },
            });
          if (value.truncated) notes.push({ key: "fileSearchPartial" });
          if (value.warnings?.length)
            errors.push(...value.warnings.map((text) => ({ text })));
        } else if (files.status === "rejected")
          errors.push({ key: "filesError", error: String(files.reason) });
        if (!threadId) notes.push({ key: "workspaceFilesAfterCreation" });
        if (threads.status === "fulfilled") {
          const available = threads.value.filter(
            (thread) => thread.threadId !== threadId,
          );
          for (const thread of available) {
            const generatedUntitled = !thread.name && !thread.preview;
            const name = thread.name || thread.preview || "Untitled thread";
            const cwd =
              thread.status === "systemError" ? "" : thread.currentMetadata.cwd;
            if (
              !`${name} ${cwd} ${thread.threadId}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase())
            )
              continue;
            if (thread.status === "systemError") {
              errors.push({ text: `${name}: ${thread.error}` });
              continue;
            }
            const duplicate = available.some(
              (other) =>
                other.threadId !== thread.threadId &&
                other.status !== "systemError" &&
                other.currentMetadata.cwd === cwd &&
                (other.name || other.preview || "Untitled thread") === name,
            );
            rows.push({
              key: `thread:${thread.threadId}`,
              kind: "thread",
              name,
              description: cwd,
              generatedUntitled,
              threadStatus: thread.status === "active" ? "active" : "idle",
              duplicateThreadId: duplicate
                ? thread.threadId.slice(0, 8)
                : undefined,
              reference: { kind: "thread", id: thread.threadId, name, cwd },
            });
          }
        } else
          errors.push({ key: "threadsError", error: String(threads.reason) });
        setResult({
          scope,
          rows,
          loading: false,
          notes,
          errors,
        });
      })().catch((error: unknown) => {
        if (!canceled && current.current === scope)
          setResult({
            scope,
            rows: [],
            loading: false,
            notes: [],
            errors: [{ text: String(error) }],
          });
      });
    }, 120);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [scope, referenceMode, open, threadId, query]);
  const commandRows: SelectorCandidate[] = slash
    ? commandCandidates(commandInput, commands, skills)
        .map((command) => ({
          key:
            command.kind === "skill"
              ? `skill:${command.id}`
              : `${command.kind}:${command.name}`,
          kind: command.kind,
          name: `/${command.name}`,
          description:
            command.kind === "built-in" && command.name === "compact"
              ? i18n.t("selector:compactThisThreadsContext")
              : command.description,
          detail:
            command.kind === "skill"
              ? `${command.source}${skills.some((other) => other.mode !== "disabled" && other.id !== command.id && other.name === command.name && other.source === command.source) ? ` · ${command.id.slice(0, 8)}` : ""}`
              : undefined,
          command,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind))
    : [];
  const all = referenceMode
    ? result.scope === scope
      ? result.rows.map((row) =>
          row.kind === "thread"
            ? {
                ...row,
                name: row.generatedUntitled
                  ? i18n.t("selector:untitledThread")
                  : row.name,
                detail: `${i18n.t(row.threadStatus === "active" ? "selector:working" : "selector:idle")}${row.duplicateThreadId ? ` · ${row.duplicateThreadId}` : ""}`,
              }
            : row,
        )
      : []
    : commandRows;
  const rows = all.slice(0, limit);
  if (all.length > limit)
    rows.push({
      key: "more",
      kind: "more",
      name: i18n.t("selector:showMore", { count: all.length - limit }),
      description: i18n.t("selector:continueMatchingResults"),
    });
  const loading = referenceMode && (result.scope !== scope || result.loading);
  const choose = async (index: number) => {
    const row = rows[index];
    if (!row || choosing === scope) return;
    if (row.kind === "more") {
      setLimit(limit + 40);
      return;
    }
    let text: string;
    let caret: number;
    let selected = parsed.skills;
    let references = parsed.references;
    if (row.command) {
      if (
        row.command.kind === "skill" &&
        !selected.some(
          (skill) =>
            skill.id === (row.command?.kind === "skill" ? row.command.id : ""),
        )
      )
        selected = [
          ...selected,
          { id: row.command.id, name: row.command.name },
        ];
      if (trigger && (trigger.start > 0 || trigger.end < parsed.text.length)) {
        const replacement = replaceTrigger(
          parsed.text,
          trigger,
          expandWorkflowCommand(commandInput, row.command),
        );
        text = replacement.text;
        caret = replacement.caret;
      } else {
        text = expandWorkflowCommand(parsed.text, row.command);
        caret = text.length;
      }
    } else if (row.reference && trigger) {
      setChoosing(scope);
      try {
        let reference = row.reference;
        if (reference.kind === "file") {
          if (!threadId) return;
          const verified = await window.zenx.workspaceFiles.validateReference(
            threadId,
            reference.path,
          );
          reference = { kind: "file", ...verified };
        } else {
          await window.zenx.protocol.request("thread/read", {
            threadId: reference.id,
          });
        }
        if (current.current !== scope) return;
        references = [
          ...references.filter(
            (value) => JSON.stringify(value) !== JSON.stringify(reference),
          ),
          reference,
        ];
        const replacement = replaceTrigger(parsed.text, trigger, "");
        text = replacement.text;
        caret = replacement.caret;
      } catch (error) {
        if (current.current === scope)
          setResult((previous) => ({
            ...previous,
            scope,
            errors: [{ key: "couldNotSelectReference", error: String(error) }],
          }));
        return;
      } finally {
        setChoosing((previous) => (previous === scope ? null : previous));
      }
    } else return;
    onChange(withSkillDraft(text, selected, references));
    setDismissed(scope);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(caret, caret);
    });
  };
  return {
    open,
    rows,
    active: Math.min(active, Math.max(0, rows.length - 1)),
    setActive,
    choose,
    loading,
    busy: choosing === scope,
    referenceMode,
    note:
      referenceMode && result.scope === scope
        ? result.notes
            .map((entry) =>
              "key" in entry ? i18n.t(`selector:${entry.key}`) : entry.text,
            )
            .join(" ")
        : "",
    error:
      referenceMode && result.scope === scope
        ? result.errors
            .map((entry) =>
              "key" in entry
                ? i18n.t(`selector:${entry.key}`, { error: entry.error })
                : entry.text,
            )
            .join("\n")
        : "",
    dismiss: () => setDismissed(scope),
    reopen: () => setDismissed(null),
    select: (element: HTMLTextAreaElement) =>
      setSelection({
        text: element.value,
        start: element.selectionStart ?? element.value.length,
        end: element.selectionEnd ?? element.value.length,
      }),
  };
}

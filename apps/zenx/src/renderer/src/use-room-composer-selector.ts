import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { replaceTrigger, selectorTrigger } from "./composer-selector.js";
import type { ComposerSuggestionState } from "./ComposerSuggestions.js";

export function useRoomComposerSelector({
  roomId,
  draft,
  members,
  textarea,
  onChange,
}: {
  roomId?: string;
  draft: string;
  members: readonly { name: string; threadId: string }[];
  textarea: RefObject<HTMLTextAreaElement | null>;
  onChange(text: string): void;
}) {
  const [selection, setSelection] = useState<{
    roomId: string | undefined;
    text: string;
    start: number;
    end: number;
  } | null>(null);
  const start =
    selection?.roomId === roomId && selection?.text === draft
      ? selection.start
      : draft.length;
  const end =
    selection?.roomId === roomId && selection?.text === draft
      ? selection.end
      : start;
  const trigger = selectorTrigger(draft, start, end);
  const scope = `${roomId ?? "none"}\0${draft}\0${start}\0${end}`;
  const pendingCaret = useRef<{
    roomId: string | undefined;
    text: string;
    caret: number;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    if (pending.roomId !== roomId) {
      pendingCaret.current = null;
      return;
    }
    if (pending.text !== draft) return;
    pendingCaret.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(pending.caret, pending.caret);
  }, [draft, roomId, textarea]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeSelection, setActiveSelection] = useState({
    scope: "",
    index: 0,
  });
  const query = trigger?.query.toLocaleLowerCase() ?? "";
  const rows = members
    .filter((member) => member.name.toLocaleLowerCase().includes(query))
    .map((member) => ({
      key: member.threadId,
      kind: "member" as const,
      name: `@${member.name}`,
      description: "Address this room member",
      member,
    }));
  const active =
    activeSelection.scope === scope
      ? Math.min(activeSelection.index, Math.max(0, rows.length - 1))
      : 0;
  const restoreCaret = (text: string, caret: number) => {
    setSelection({ roomId, text, start: caret, end: caret });
    pendingCaret.current = { roomId, text, caret };
  };
  const selector: ComposerSuggestionState = {
    open:
      roomId !== undefined &&
      members.length > 0 &&
      trigger?.kind === "reference" &&
      dismissed !== scope,
    rows,
    active,
    setActive: (index) => setActiveSelection({ scope, index }),
    choose: (index) => {
      const row = rows[index];
      if (!row || !trigger || trigger.kind !== "reference") return;
      const replacement = replaceTrigger(draft, trigger, row.name);
      const caret =
        replacement.caret +
        (/\s/u.test(replacement.text[replacement.caret] ?? "") ? 1 : 0);
      onChange(replacement.text);
      setDismissed(
        `${roomId ?? "none"}\0${replacement.text}\0${caret}\0${caret}`,
      );
      restoreCaret(replacement.text, caret);
    },
    dismiss: () => setDismissed(scope),
    loading: false,
    busy: false,
    note: "",
    error: "",
  };
  return {
    ...selector,
    reopen: () => setDismissed(null),
    select: (element: HTMLTextAreaElement) =>
      setSelection({
        roomId,
        text: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
      }),
    openMembers: () => {
      const input = textarea.current;
      const start = input?.selectionStart ?? draft.length;
      const end = input?.selectionEnd ?? start;
      const prefix = draft.slice(0, start);
      const insertion = `${prefix && !/\s$/u.test(prefix) ? " " : ""}@`;
      const text = `${prefix}${insertion}${draft.slice(end)}`;
      onChange(text);
      setDismissed(null);
      restoreCaret(text, start + insertion.length);
    },
  };
}

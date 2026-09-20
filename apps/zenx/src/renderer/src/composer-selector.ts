export interface SelectorTrigger {
  kind: "command" | "reference";
  query: string;
  start: number;
  end: number;
}

export function selectorTrigger(
  text: string,
  start: number,
  end = start,
): SelectorTrigger | null {
  if (start !== end) return null;
  const match =
    /(?:^|\s)(@)([^\s@]*)$/u.exec(text.slice(0, start)) ??
    /(?:^|\s)(\/)([^\s@/]*)$/u.exec(text.slice(0, start));
  if (!match) return null;
  const query = match[2]!;
  return {
    kind: match[1] === "@" ? "reference" : "command",
    query,
    start: start - query.length - 1,
    end: start,
  };
}

export function replaceTrigger(
  text: string,
  trigger: SelectorTrigger,
  insertion: string,
) {
  const suffix = text.slice(trigger.end);
  const separator = suffix.length === 0 || !/^\s/u.test(suffix) ? " " : "";
  return {
    text: text.slice(0, trigger.start) + insertion + separator + suffix,
    caret: trigger.start + insertion.length + separator.length,
  };
}

export type Reference =
  | { kind: "file"; name: string; cwd: string; path: string }
  | { kind: "thread"; name: string; cwd: string; id: string };

// JSON string quoting retains spaces, Unicode, newlines and punctuation without
// giving display names or paths a second parser/authority in the conversation.
export function referenceText(reference: Reference): string {
  return reference.kind === "file"
    ? `[File reference: ${JSON.stringify(reference.name)}; workspace: ${JSON.stringify(reference.cwd)}; relative path: ${JSON.stringify(reference.path)}]`
    : `[Thread reference: ${JSON.stringify(reference.name)}; thread ID: ${JSON.stringify(reference.id)}; workspace: ${JSON.stringify(reference.cwd)}]`;
}

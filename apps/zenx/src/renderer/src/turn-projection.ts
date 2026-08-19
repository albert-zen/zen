import type { ThreadItem, Turn } from "../../protocol-client/index.js";

export type TurnDisplayNode =
  | { kind: "agent"; item: Extract<ThreadItem, { type: "agentMessage" }> }
  | {
      kind: "trace";
      id: string;
      items: Array<
        Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>
      >;
      summary: string;
    };

export interface TurnDisplayProjection {
  userItems: Array<Extract<ThreadItem, { type: "userMessage" }>>;
  history: TurnDisplayNode[];
  finalItem: Extract<ThreadItem, { type: "agentMessage" }> | null;
  terminalFallback: string | null;
}

export function projectTurn(turn: Turn): TurnDisplayProjection {
  const userItems = turn.items.filter(
    (item): item is Extract<ThreadItem, { type: "userMessage" }> =>
      item.type === "userMessage",
  );
  const responseItems = turn.items.filter(
    (item) => item.type !== "userMessage",
  );
  const agentItems = responseItems.filter(
    (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
      item.type === "agentMessage" && item.text.length > 0,
  );
  const finalItem =
    turn.status === "inProgress" ? null : (agentItems.at(-1) ?? null);
  const historySource =
    finalItem === null
      ? responseItems
      : responseItems.filter((item) => item.id !== finalItem.id);
  const history: TurnDisplayNode[] = [];
  let traceItems: Array<
    Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>
  > = [];
  const flushTrace = () => {
    if (traceItems.length === 0) return;
    history.push({
      kind: "trace",
      id: traceItems.map((item) => item.id).join(":"),
      summary: traceSummary(traceItems),
      items: traceItems,
    });
    traceItems = [];
  };
  for (const item of historySource) {
    if (item.type === "reasoning" || item.type === "commandExecution") {
      traceItems.push(item);
      continue;
    }
    flushTrace();
    if (item.type === "agentMessage") history.push({ kind: "agent", item });
  }
  flushTrace();
  return {
    userItems,
    history,
    finalItem,
    terminalFallback:
      turn.status === "inProgress" || finalItem !== null
        ? null
        : turn.error?.message ??
          (turn.status === "interrupted"
            ? "This turn was interrupted before a final response arrived."
            : "This turn ended without a final response."),
  };
}

export function traceSummary(
  items: readonly Extract<
    ThreadItem,
    { type: "reasoning" | "commandExecution" }
  >[],
): string {
  const commands = items.filter(
    (item): item is Extract<ThreadItem, { type: "commandExecution" }> =>
      item.type === "commandExecution",
  );
  const reasoning = items.length - commands.length;
  if (commands.length === 0) return "Reasoned through the next step";
  const names = commands.map((item) => commandLabel(item.command));
  const unique = [...new Set(names)];
  const action = unique.length === 1 ? unique[0] : `${unique.length} tools`;
  return reasoning > 0 ? `Reasoned and used ${action}` : `Used ${action}`;
}

export function commandLabel(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? "tool";
  return first.replace(/^zenx_/u, "").replaceAll("_", " ");
}

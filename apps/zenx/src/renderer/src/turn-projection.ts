import { i18n } from "./i18n.js";
import { settledTraceSummary, traceAction } from "./trace-action-summary.js";
import type { IconName } from "./icons.js";
import type { ThreadItem, Turn } from "../../protocol-client/index.js";
import {
  commandSummary,
  commandActionCompleted,
  commandPhase,
  toolPresentation,
  type CommandPhase,
  type CommandItem,
} from "./tool-presentation.js";

export type TurnDisplayNode =
  | {
      kind: "input";
      id: string;
      item: Extract<
        ThreadItem,
        { type: "userMessage" | "threadMessage" | "hostMessage" }
      >;
    }
  | { kind: "agent"; item: Extract<ThreadItem, { type: "agentMessage" }> }
  | {
      kind: "traceItem";
      id: string;
      item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>;
    }
  | {
      kind: "traceGroup";
      id: string;
      items: Array<
        Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>
      >;
      summary: string;
    };

export interface TurnDisplayProjection {
  inputItems: Array<
    Extract<
      ThreadItem,
      { type: "userMessage" | "threadMessage" | "hostMessage" }
    >
  >;
  history: TurnDisplayNode[];
  finalItem: Extract<ThreadItem, { type: "agentMessage" }> | null;
  terminalFallback: string | null;
}

export interface TraceDisplayRow {
  item: Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>;
  nested: boolean;
  parentToolName: string | null;
}

/** Only adjacent completed reasoning items with no public summary or content share a visual row; visibility is not projected. */
export function groupReasoningWithoutDetailsRows(
  rows: readonly TraceDisplayRow[],
): Array<
  TraceDisplayRow | { kind: "reasoningWithoutDetailsRun"; ids: string[] }
> {
  const result: Array<
    TraceDisplayRow | { kind: "reasoningWithoutDetailsRun"; ids: string[] }
  > = [];
  let run: TraceDisplayRow[] = [];
  const flush = () => {
    if (run.length > 1) {
      result.push({
        kind: "reasoningWithoutDetailsRun",
        ids: run.map((row) => row.item.id),
      });
    } else if (run[0] !== undefined) {
      result.push(run[0]);
    }
    run = [];
  };
  for (const row of rows) {
    const item = row.item;
    if (
      item.type === "reasoning" &&
      item.status !== "inProgress" &&
      item.status !== "interrupted" &&
      item.summary.every((part) => part.trim().length === 0) &&
      item.content.every((part) => part.trim().length === 0)
    ) {
      run.push(row);
    } else {
      flush();
      result.push(row);
    }
  }
  flush();
  return result;
}

/** Derive visual lineage solely from canonical call ids carried by the wire projection. */
export function traceDisplayRows(
  items: readonly Extract<
    ThreadItem,
    { type: "reasoning" | "commandExecution" }
  >[],
): TraceDisplayRow[] {
  const calls = new Map(
    items.flatMap((item) =>
      item.type === "commandExecution" && item.callId !== undefined
        ? [[item.callId, item] as const]
        : [],
    ),
  );
  return items.map((item) => {
    if (item.type !== "commandExecution" || item.parentCallId === undefined) {
      return { item, nested: false, parentToolName: null };
    }
    const parent = calls.get(item.parentCallId);
    return {
      item,
      nested: parent !== undefined,
      parentToolName: parent?.toolName ?? null,
    };
  });
}

export function projectTurn(turn: Turn): TurnDisplayProjection {
  const inputItems = turn.items.filter(
    (
      item,
    ): item is Extract<
      ThreadItem,
      { type: "userMessage" | "threadMessage" | "hostMessage" }
    > =>
      (item.type === "userMessage" ||
        item.type === "threadMessage" ||
        item.type === "hostMessage") &&
      item.deliveryAfter === undefined,
  );
  const steers = turn.items.filter(
    (
      item,
    ): item is Extract<
      ThreadItem,
      { type: "userMessage" | "threadMessage" | "hostMessage" }
    > =>
      (item.type === "userMessage" ||
        item.type === "threadMessage" ||
        item.type === "hostMessage") &&
      item.deliveryAfter !== undefined,
  );
  const responseItems = turn.items.filter(
    (item) =>
      item.type !== "userMessage" &&
      item.type !== "threadMessage" &&
      item.type !== "hostMessage",
  );
  const agentItems = responseItems.filter(
    (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
      item.type === "agentMessage" && item.text.length > 0,
  );
  const finalItem =
    turn.status === "completed" ? (agentItems.at(-1) ?? null) : null;
  const historySource =
    finalItem === null
      ? responseItems
      : responseItems.filter((item) => item.id !== finalItem.id);
  const steersByAnchor = new Map<
    string,
    Array<
      Extract<
        ThreadItem,
        { type: "userMessage" | "threadMessage" | "hostMessage" }
      >
    >
  >();
  for (const steer of steers) {
    const anchor = steer.deliveryAfter;
    if (anchor === undefined) continue;
    const entries = steersByAnchor.get(anchor) ?? [];
    entries.push(steer);
    steersByAnchor.set(anchor, entries);
  }
  const lastAnchorIndex = new Map<string, number>();
  for (let index = 0; index < historySource.length; index += 1) {
    const item = historySource[index];
    if (item === undefined) continue;
    for (const anchor of steersByAnchor.keys()) {
      if (
        item.id === anchor ||
        (item.type === "commandExecution" && item.modelResponseId === anchor)
      ) {
        lastAnchorIndex.set(anchor, index);
      }
    }
  }
  const steersAfterIndex = new Map<
    number,
    Array<
      Extract<
        ThreadItem,
        { type: "userMessage" | "threadMessage" | "hostMessage" }
      >
    >
  >();
  const unanchoredSteers: Array<
    Extract<
      ThreadItem,
      { type: "userMessage" | "threadMessage" | "hostMessage" }
    >
  > = [];
  for (const [anchor, entries] of steersByAnchor) {
    const index = lastAnchorIndex.get(anchor);
    if (index === undefined) {
      unanchoredSteers.push(...entries);
      continue;
    }
    const target = steersAfterIndex.get(index) ?? [];
    target.push(...entries);
    steersAfterIndex.set(index, target);
  }
  const history: TurnDisplayNode[] = [];
  let traceItems: Array<
    Extract<ThreadItem, { type: "reasoning" | "commandExecution" }>
  > = [];
  const flushTrace = () => {
    if (traceItems.length === 0) return;
    const id = traceItems[0]!.id;
    history.push(
      traceItems.length === 1
        ? { kind: "traceItem", id, item: traceItems[0]! }
        : {
            kind: "traceGroup",
            id,
            summary: traceSummary(traceItems, turn.status),
            items: traceItems,
          },
    );
    traceItems = [];
  };
  const appendSteersAfter = (index: number) => {
    const entries = steersAfterIndex.get(index);
    if (entries === undefined) return;
    history.push(
      ...entries.map((item) => ({ kind: "input" as const, id: item.id, item })),
    );
  };
  for (let index = 0; index < historySource.length; index += 1) {
    const item = historySource[index];
    if (item === undefined) continue;
    if (item.type === "reasoning" || item.type === "commandExecution") {
      traceItems.push(item);
      if (steersAfterIndex.has(index)) {
        flushTrace();
        appendSteersAfter(index);
      }
      continue;
    }
    flushTrace();
    if (item.type === "agentMessage") history.push({ kind: "agent", item });
    appendSteersAfter(index);
  }
  flushTrace();
  history.push(
    ...unanchoredSteers.map((item) => ({
      kind: "input" as const,
      id: item.id,
      item,
    })),
  );
  return {
    inputItems,
    history,
    finalItem,
    terminalFallback:
      turn.status === "inProgress" || finalItem !== null
        ? null
        : (turn.error?.message ??
          (turn.status === "interrupted"
            ? i18n.t("shell:thisTurnWasInterruptedBeforeAFinalResponseArrived")
            : i18n.t("shell:thisTurnEndedWithoutAFinalResponse"))),
  };
}

export interface TraceActivity {
  total: number;
  active: number;
  current: CommandItem | null;
  phase: CommandPhase | "thinking" | "idle";
  categories: Array<{ label: string; count: number }>;
}
export function summarizeTraceActivity(
  items: readonly ThreadItem[],
  turnStatus: Turn["status"] = "inProgress",
): TraceActivity {
  const result: TraceActivity = {
    total: 0,
    active: 0,
    current: null,
    phase: "idle",
    categories: [],
  };
  const categories = new Map<string, number>();
  const active: Array<{ item: CommandItem; phase: CommandPhase }> = [];
  for (const item of items) {
    if (item.type !== "commandExecution") continue;
    result.total += 1;
    const category = toolPresentation(item.toolName ?? item.command).category;
    categories.set(category, (categories.get(category) ?? 0) + 1);
    const phase = commandPhase(item, turnStatus);
    if (phase !== "requested") continue;
    active.push({ item, phase });
    result.active += 1;
  }
  const current = active.at(-1);
  result.current = current?.item ?? null;
  result.phase =
    current?.phase ??
    (turnStatus === "inProgress" &&
    items.some(
      (item) => item.type === "reasoning" && item.status === "inProgress",
    )
      ? "thinking"
      : "idle");
  result.categories = [...categories].map(([label, count]) => ({
    label,
    count,
  }));
  return result;
}
export function traceSummary(
  items: readonly ThreadItem[],
  turnStatus: Turn["status"] = "inProgress",
): string {
  const activity = summarizeTraceActivity(items, turnStatus);
  if (activity.phase === "thinking") return i18n.t("shell:thinking");
  const commands = items.filter(
    (item): item is CommandItem => item.type === "commandExecution",
  );
  if (commands.length === 1) {
    const item = commands[0]!;
    return commandSummary(item, turnStatus);
  }
  if (activity.current) return commandSummary(activity.current, turnStatus);
  if (activity.total === 0) return i18n.t("shell:thoughts");
  return settledTraceSummary(commands, (item) =>
    commandActionCompleted(item) ? commandPhase(item, turnStatus) : "unknown",
  );
}

export function traceGroupIcons(items: readonly ThreadItem[]): IconName[] {
  const icons = items.flatMap((item) =>
    item.type === "commandExecution" ? [traceAction(item).icon] : [],
  );
  // Reuse real capability glyphs (including their existing unknown fallback),
  // in first-seen order. A bounded set stays stable as more calls arrive.
  return icons.length === 0 ? ["reasoning"] : [...new Set(icons)].slice(0, 2);
}

export function commandLabel(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? "tool";
  return first.replace(/^zenx_/u, "").replaceAll("_", " ");
}

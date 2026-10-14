import { i18n } from "./i18n.js";
import type { ThreadItem, Turn } from "../../protocol-client/index.js";
import {
  commandSummary,
  commandPhaseLabel,
  commandPhase,
  commandTask,
  isTerminalCommandPhase,
  commandTitle,
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

export function projectTurn(
  turn: Turn,
  observations: TraceObservationIndex = createTraceObservationIndex(turn.items),
): TurnDisplayProjection {
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
            summary: traceSummary(traceItems, observations),
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

export interface TraceObservationIndex {
  tasks: ReadonlyMap<string, { itemId: string; phase: CommandPhase }>;
}
/** Disposable observation facts, never a second runtime state. A task cannot restart. */
export function createTraceObservationIndex(
  items: readonly ThreadItem[],
): TraceObservationIndex {
  const tasks = new Map<string, { itemId: string; phase: CommandPhase }>();
  for (const item of items) {
    if (item.type !== "commandExecution") continue;
    const task = commandTask(item);
    if (task === null) continue;
    const prior = tasks.get(task.id);
    if (
      prior &&
      isTerminalCommandPhase(prior.phase) &&
      !isTerminalCommandPhase(task.phase)
    )
      continue;
    tasks.set(task.id, { itemId: item.id, phase: task.phase });
  }
  return { tasks };
}
export function observedCommandPhase(
  item: CommandItem,
  observations: TraceObservationIndex,
): CommandPhase {
  const phase = commandPhase(item);
  const task = commandTask(item);
  if (task === null || isTerminalCommandPhase(phase)) return phase;
  return observations.tasks.get(task.id)?.phase ?? phase;
}
export interface TraceActivity {
  total: number;
  active: number;
  outstanding: number;
  failed: number;
  cancelled: number;
  unconfirmed: number;
  pending: number;
  running: number;
  waiting: number;
  current: CommandItem | null;
  phase: CommandPhase | "thinking" | "idle";
  categories: Array<{ label: string; count: number }>;
}
export function summarizeTraceActivity(
  items: readonly ThreadItem[],
  context: TraceObservationIndex | readonly ThreadItem[] = items,
): TraceActivity {
  const observations = Array.isArray(context)
    ? createTraceObservationIndex(context)
    : (context as TraceObservationIndex);
  const result: TraceActivity = {
    total: 0,
    active: 0,
    outstanding: 0,
    failed: 0,
    cancelled: 0,
    unconfirmed: 0,
    pending: 0,
    running: 0,
    waiting: 0,
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
    const phase = commandPhase(item);
    if (phase === "failed" || phase === "timed_out") result.failed += 1;
    if (phase === "cancelled" || phase === "declined") result.cancelled += 1;
    const task = commandTask(item);
    const observed = task === null ? null : observations.tasks.get(task.id);
    if (
      isTerminalCommandPhase(phase) ||
      (observed &&
        (isTerminalCommandPhase(observed.phase) || observed.itemId !== item.id))
    )
      continue;
    active.push({ item, phase });
    result.active += 1;
    if (task !== null) result.outstanding += 1;
    if (phase === "running") result.running += 1;
    if (phase === "waiting") result.waiting += 1;
    if (phase === "cancellation_unconfirmed") result.unconfirmed += 1;
    if (
      phase === "cancel_requested" ||
      phase === "queued" ||
      phase === "admitting" ||
      phase === "requested"
    )
      result.pending += 1;
  }
  const priority: CommandPhase[] = [
    "cancellation_unconfirmed",
    "cancel_requested",
    "running",
    "waiting",
    "admitting",
    "queued",
    "requested",
  ];
  const current = priority
    .map((phase) => active.findLast((entry) => entry.phase === phase))
    .find(Boolean);
  result.current = current?.item ?? null;
  result.phase =
    current?.phase ??
    (items.some(
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
  observations: TraceObservationIndex | readonly ThreadItem[] = items,
): string {
  const index = Array.isArray(observations)
    ? createTraceObservationIndex(observations)
    : (observations as TraceObservationIndex);
  const activity = summarizeTraceActivity(items, index);
  if (activity.phase === "thinking") return i18n.t("shell:thinking");
  const commands = items.filter(
    (item): item is CommandItem => item.type === "commandExecution",
  );
  if (commands.length === 1) {
    const item = commands[0]!;
    const phase = observedCommandPhase(item, index);
    return phase === commandPhase(item)
      ? commandSummary(item)
      : `${commandTitle(item)} · ${commandPhaseLabel(phase).toLowerCase()}`;
  }
  if (activity.current) return commandTitle(activity.current);
  if (activity.total === 0) return i18n.t("shell:thoughts");
  // Keep the recent action context after settlement, without presenting the
  // call count as successful work. Full chronological detail stays in the fold.
  return [
    i18n.t("shell:toolCalls", { count: activity.total }),
    ...commands
      .slice(-3)
      .reverse()
      .map((item) => {
        const phase = observedCommandPhase(item, index);
        return phase === commandPhase(item)
          ? commandSummary(item)
          : `${commandTitle(item)} · ${commandPhaseLabel(phase).toLowerCase()}`;
      }),
  ].join(" · ");
}

export function commandLabel(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? "tool";
  return first.replace(/^zenx_/u, "").replaceAll("_", " ");
}

import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  RoomMember,
  RoomMessage,
  TriggerHistoryEntry,
  TriggerProgramConfig,
  TriggerProgramOutcome,
  TriggerProgramSpec,
  TriggerSnapshot,
  ZenXRoom,
  ZenXTrigger,
} from "./trigger-types.js";

interface StoredState extends TriggerSnapshot {
  version: 3;
}

interface Version2StoredState extends Omit<TriggerSnapshot, "history"> {
  version: 2;
  history: Array<
    Omit<
      TriggerHistoryEntry,
      | "replyRoomId"
      | "replyAuthor"
      | "programInvocationId"
      | "programOutcome"
      | "programOutcomes"
    >
  >;
}

interface LegacyStoredState extends Omit<TriggerSnapshot, "history"> {
  version: 1;
  history: Array<
    Omit<
      TriggerHistoryEntry,
      | "sourceThreadId"
      | "sourceTurnId"
      | "sourceRoomId"
      | "sourceRoomMessageId"
      | "replyRoomId"
      | "replyAuthor"
      | "programInvocationId"
      | "programOutcome"
    >
  >;
}

export class ZenXTriggerStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async read(): Promise<TriggerSnapshot> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptySnapshot();
      throw error;
    }
    try {
      const value = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (isStoredState(value)) return snapshotFrom(value);
      if (isVersion2StoredState(value)) {
        return {
          triggers: value.triggers,
          history: value.history.map((entry) => ({
            ...entry,
            replyRoomId: null,
            replyAuthor: null,
            programInvocationId: null,
            programOutcome: null,
            programOutcomes: [],
          })),
          rooms: value.rooms,
        };
      }
      if (isLegacyStoredState(value)) {
        return {
          triggers: value.triggers,
          history: value.history.map((entry) => ({
            ...entry,
            sourceThreadId: null,
            sourceTurnId: null,
            sourceRoomId: null,
            sourceRoomMessageId: null,
            replyRoomId: null,
            replyAuthor: null,
            programInvocationId: null,
            programOutcome: null,
            programOutcomes: [],
          })),
          rooms: value.rooms,
        };
      }
      throw new Error(
        "ZenX trigger registry has an unsupported version or invalid entry shape",
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX trigger registry contains invalid JSON");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async write(snapshot: TriggerSnapshot): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    const value: StoredState = { version: 3, ...snapshot };
    if (!isStoredState(value))
      throw new Error("ZenX refused to persist an invalid trigger registry");
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#filePath);
  }
}

function emptySnapshot(): TriggerSnapshot {
  return { triggers: [], history: [], rooms: [] };
}

function snapshotFrom(value: StoredState): TriggerSnapshot {
  return {
    triggers: value.triggers,
    history: value.history,
    rooms: value.rooms,
  };
}

function isStoredState(value: unknown): value is StoredState {
  const state = record(value);
  return (
    state !== null &&
    state["version"] === 3 &&
    arrayOf(state["triggers"], isTrigger) &&
    arrayOf(state["history"], isHistory) &&
    arrayOf(state["rooms"], isRoom)
  );
}

function isVersion2StoredState(value: unknown): value is Version2StoredState {
  const state = record(value);
  return (
    state !== null &&
    state["version"] === 2 &&
    arrayOf(state["triggers"], isTrigger) &&
    arrayOf(state["history"], isVersion2History) &&
    arrayOf(state["rooms"], isRoom)
  );
}

function isLegacyStoredState(value: unknown): value is LegacyStoredState {
  const state = record(value);
  return (
    state !== null &&
    state["version"] === 1 &&
    arrayOf(state["triggers"], isTrigger) &&
    arrayOf(state["history"], isLegacyHistory) &&
    arrayOf(state["rooms"], isRoom)
  );
}

function isTrigger(value: unknown): value is ZenXTrigger {
  const trigger = record(value);
  if (
    trigger === null ||
    !string(trigger["id"]) ||
    !string(trigger["threadId"]) ||
    !triggerKind(trigger["kind"]) ||
    !string(trigger["label"]) ||
    !string(trigger["prompt"]) ||
    !finiteNumber(trigger["createdAt"]) ||
    typeof trigger["active"] !== "boolean" ||
    (trigger["program"] !== undefined && !isProgramConfig(trigger["program"]))
  )
    return false;
  if (trigger["kind"] === "timer") {
    const timer = record(trigger["timer"]);
    return (
      timer !== null &&
      finiteNumber(timer["nextRunAt"]) &&
      (timer["intervalMinutes"] === null ||
        (finiteNumber(timer["intervalMinutes"]) &&
          timer["intervalMinutes"] > 0))
    );
  }
  if (trigger["kind"] === "thread") {
    const watch = record(trigger["watch"]);
    return (
      watch !== null &&
      string(watch["threadId"]) &&
      watch["event"] === "turn_completed"
    );
  }
  if (trigger["kind"] === "roomMention") {
    const room = record(trigger["room"]);
    return room !== null && string(room["roomId"]) && string(room["mention"]);
  }
  const signal = record(trigger["signal"]);
  return signal !== null && string(signal["name"]);
}

function isHistory(value: unknown): value is TriggerHistoryEntry {
  const entry = record(value);
  return (
    isVersion2History(value) &&
    entry !== null &&
    nullableString(entry["replyRoomId"]) &&
    nullableString(entry["replyAuthor"]) &&
    nullableString(entry["programInvocationId"]) &&
    (entry["programOutcome"] === null ||
      isProgramOutcome(entry["programOutcome"])) &&
    arrayOf(entry["programOutcomes"], isProgramOutcome)
  );
}

function isVersion2History(
  value: unknown,
): value is Version2StoredState["history"][number] {
  const entry = record(value);
  return (
    isLegacyHistory(value) &&
    entry !== null &&
    nullableString(entry["sourceThreadId"]) &&
    nullableString(entry["sourceTurnId"]) &&
    nullableString(entry["sourceRoomId"]) &&
    nullableString(entry["sourceRoomMessageId"])
  );
}

function isLegacyHistory(
  value: unknown,
): value is LegacyStoredState["history"][number] {
  const entry = record(value);
  return (
    entry !== null &&
    string(entry["id"]) &&
    string(entry["triggerId"]) &&
    string(entry["threadId"]) &&
    triggerKind(entry["kind"]) &&
    string(entry["reason"]) &&
    string(entry["prompt"]) &&
    string(entry["clientUserMessageId"]) &&
    finiteNumber(entry["startedAt"]) &&
    nullableNumber(entry["completedAt"]) &&
    historyStatus(entry["status"]) &&
    nullableString(entry["turnId"]) &&
    nullableString(entry["error"])
  );
}

function isProgramConfig(value: unknown): value is TriggerProgramConfig {
  const config = record(value);
  return (
    config !== null &&
    (config["predicate"] === undefined || isProgramSpec(config["predicate"])) &&
    (config["action"] === undefined || isProgramSpec(config["action"])) &&
    (config["match"] === undefined || isMatch(config["match"])) &&
    (config["predicate"] !== undefined ||
      config["action"] !== undefined ||
      config["match"] !== undefined)
  );
}

function isProgramSpec(value: unknown): value is TriggerProgramSpec {
  const spec = record(value);
  if (
    spec === null ||
    !string(spec["command"]) ||
    (spec["args"] !== undefined &&
      !arrayOf(
        spec["args"],
        (entry): entry is string => typeof entry === "string",
      )) ||
    (spec["cwd"] !== undefined && !string(spec["cwd"])) ||
    (spec["env"] !== undefined &&
      (record(spec["env"]) === null ||
        Object.values(spec["env"] as Record<string, unknown>).some(
          (entry) => typeof entry !== "string",
        ))) ||
    (spec["timeoutMs"] !== undefined &&
      (!finiteNumber(spec["timeoutMs"]) || spec["timeoutMs"] <= 0)) ||
    (spec["maxOutputBytes"] !== undefined &&
      (!Number.isSafeInteger(spec["maxOutputBytes"]) ||
        (spec["maxOutputBytes"] as number) < 256 ||
        (spec["maxOutputBytes"] as number) > 1024 * 1024))
  )
    return false;
  return true;
}

function isMatch(value: unknown): boolean {
  const match = record(value);
  if (
    match === null ||
    match["field"] !== "completedItemText" ||
    !string(match["regex"]) ||
    (match["flags"] !== undefined && !string(match["flags"]))
  )
    return false;
  try {
    new RegExp(match["regex"] as string, (match["flags"] as string) ?? "u");
    return true;
  } catch {
    return false;
  }
}

function isProgramOutcome(value: unknown): value is TriggerProgramOutcome {
  const outcome = record(value);
  return (
    outcome !== null &&
    (outcome["stage"] === "predicate" || outcome["stage"] === "action") &&
    programStatus(outcome["status"]) &&
    string(outcome["invocationId"]) &&
    nullableString(outcome["output"]) &&
    nullableNumber(outcome["exitCode"]) &&
    nullableString(outcome["error"])
  );
}

function isRoom(value: unknown): value is ZenXRoom {
  const room = record(value);
  if (
    room === null ||
    !string(room["id"]) ||
    !string(room["name"]) ||
    !arrayOf(room["members"], isRoomMember) ||
    !arrayOf(room["messages"], isRoomMessage) ||
    !finiteNumber(room["createdAt"])
  )
    return false;
  const names = new Set<string>();
  const threads = new Set<string>();
  for (const member of room["members"]) {
    const name = member.name.toLocaleLowerCase();
    if (names.has(name) || threads.has(member.threadId)) return false;
    names.add(name);
    threads.add(member.threadId);
  }
  return room["messages"].every((message) => message.roomId === room["id"]);
}

function isRoomMember(value: unknown): value is RoomMember {
  const member = record(value);
  return (
    member !== null && string(member["name"]) && string(member["threadId"])
  );
}

function isRoomMessage(value: unknown): value is RoomMessage {
  const message = record(value);
  return (
    message !== null &&
    string(message["id"]) &&
    string(message["roomId"]) &&
    string(message["author"]) &&
    string(message["text"]) &&
    finiteNumber(message["createdAt"]) &&
    (message["kind"] === "human" ||
      message["kind"] === "agent" ||
      message["kind"] === "system") &&
    nullableString(message["originThreadId"]) &&
    nullableString(message["originTurnId"])
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOf<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) && value.every(predicate);
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || string(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

function triggerKind(value: unknown): value is ZenXTrigger["kind"] {
  return (
    value === "timer" ||
    value === "thread" ||
    value === "roomMention" ||
    value === "signal"
  );
}

function historyStatus(value: unknown): value is TriggerHistoryEntry["status"] {
  return (
    value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  );
}

function programStatus(
  value: unknown,
): value is TriggerProgramOutcome["status"] {
  return (
    value === "matched" ||
    value === "non_match" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "nonzero_exit" ||
    value === "malformed_output" ||
    value === "oversized_output" ||
    value === "uncertain"
  );
}

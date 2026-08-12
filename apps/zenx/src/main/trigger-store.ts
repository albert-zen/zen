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
import {
  MAX_ERROR_BYTES,
  MAX_HISTORY_COUNT,
  MAX_ID_BYTES,
  MAX_MEMBER_NAME_BYTES,
  MAX_MESSAGE_AUTHOR_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_PROGRAM_ARGUMENT_BYTES,
  MAX_PROGRAM_ARGUMENTS,
  MAX_PROGRAM_COMMAND_BYTES,
  MAX_PROGRAM_CWD_BYTES,
  MAX_PROGRAM_ENV_BYTES,
  MAX_PROGRAM_ENV_ENTRIES,
  MAX_PROGRAM_ENV_KEY_BYTES,
  MAX_PROGRAM_ENV_VALUE_BYTES,
  MAX_PROGRAM_FLAGS_BYTES,
  MAX_PROGRAM_MATCH_REGEX_BYTES,
  MAX_PROGRAM_OUTCOMES,
  MAX_REASON_BYTES,
  MAX_ROOM_COUNT,
  MAX_ROOM_MEMBERS,
  MAX_ROOM_MESSAGES,
  MAX_ROOM_NAME_BYTES,
  MAX_TRIGGER_COUNT,
  MAX_TRIGGER_LABEL_BYTES,
  MAX_TRIGGER_PROMPT_BYTES,
  utf8Bytes,
  withinBytes,
} from "./trigger-limits.js";

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
    arrayOf(state["triggers"], isTrigger, MAX_TRIGGER_COUNT) &&
    arrayOf(state["history"], isHistory, MAX_HISTORY_COUNT) &&
    arrayOf(state["rooms"], isRoom, MAX_ROOM_COUNT)
  );
}

function isVersion2StoredState(value: unknown): value is Version2StoredState {
  const state = record(value);
  return (
    state !== null &&
    state["version"] === 2 &&
    arrayOf(state["triggers"], isTrigger, MAX_TRIGGER_COUNT) &&
    arrayOf(state["history"], isVersion2History, MAX_HISTORY_COUNT) &&
    arrayOf(state["rooms"], isRoom, MAX_ROOM_COUNT)
  );
}

function isLegacyStoredState(value: unknown): value is LegacyStoredState {
  const state = record(value);
  return (
    state !== null &&
    state["version"] === 1 &&
    arrayOf(state["triggers"], isTrigger, MAX_TRIGGER_COUNT) &&
    arrayOf(state["history"], isLegacyHistory, MAX_HISTORY_COUNT) &&
    arrayOf(state["rooms"], isRoom, MAX_ROOM_COUNT)
  );
}

function isTrigger(value: unknown): value is ZenXTrigger {
  const trigger = record(value);
  if (
    trigger === null ||
    !string(trigger["id"], MAX_ID_BYTES) ||
    !string(trigger["threadId"], MAX_ID_BYTES) ||
    !triggerKind(trigger["kind"]) ||
    !string(trigger["label"], MAX_TRIGGER_LABEL_BYTES) ||
    !string(trigger["prompt"], MAX_TRIGGER_PROMPT_BYTES) ||
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
      string(watch["threadId"], MAX_ID_BYTES) &&
      watch["event"] === "turn_completed"
    );
  }
  if (trigger["kind"] === "roomMention") {
    const room = record(trigger["room"]);
    return (
      room !== null &&
      string(room["roomId"], MAX_ID_BYTES) &&
      string(room["mention"], MAX_MEMBER_NAME_BYTES)
    );
  }
  const signal = record(trigger["signal"]);
  return signal !== null && string(signal["name"], MAX_ID_BYTES);
}

function isHistory(value: unknown): value is TriggerHistoryEntry {
  const entry = record(value);
  return (
    isVersion2History(value) &&
    entry !== null &&
    nullableString(entry["replyRoomId"], MAX_ID_BYTES) &&
    nullableString(entry["replyAuthor"], MAX_MEMBER_NAME_BYTES) &&
    nullableString(entry["programInvocationId"], MAX_ID_BYTES) &&
    (entry["programOutcome"] === null ||
      isProgramOutcome(entry["programOutcome"])) &&
    arrayOf(entry["programOutcomes"], isProgramOutcome, MAX_PROGRAM_OUTCOMES)
  );
}

function isVersion2History(
  value: unknown,
): value is Version2StoredState["history"][number] {
  const entry = record(value);
  return (
    isLegacyHistory(value) &&
    entry !== null &&
    nullableString(entry["sourceThreadId"], MAX_ID_BYTES) &&
    nullableString(entry["sourceTurnId"], MAX_ID_BYTES) &&
    nullableString(entry["sourceRoomId"], MAX_ID_BYTES) &&
    nullableString(entry["sourceRoomMessageId"], MAX_ID_BYTES)
  );
}

function isLegacyHistory(
  value: unknown,
): value is LegacyStoredState["history"][number] {
  const entry = record(value);
  return (
    entry !== null &&
    string(entry["id"], MAX_ID_BYTES) &&
    string(entry["triggerId"], MAX_ID_BYTES) &&
    string(entry["threadId"], MAX_ID_BYTES) &&
    triggerKind(entry["kind"]) &&
    string(entry["reason"], MAX_REASON_BYTES) &&
    string(entry["prompt"], MAX_TRIGGER_PROMPT_BYTES) &&
    string(entry["clientUserMessageId"], MAX_ID_BYTES) &&
    finiteNumber(entry["startedAt"]) &&
    nullableNumber(entry["completedAt"]) &&
    historyStatus(entry["status"]) &&
    nullableString(entry["turnId"], MAX_ID_BYTES) &&
    nullableString(entry["error"], MAX_ERROR_BYTES)
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
    !string(spec["command"], MAX_PROGRAM_COMMAND_BYTES) ||
    (spec["args"] !== undefined &&
      !arrayOf(
        spec["args"],
        (entry): entry is string =>
          typeof entry === "string" &&
          withinBytes(entry, MAX_PROGRAM_ARGUMENT_BYTES),
        MAX_PROGRAM_ARGUMENTS,
      )) ||
    (spec["cwd"] !== undefined &&
      !string(spec["cwd"], MAX_PROGRAM_CWD_BYTES)) ||
    (spec["env"] !== undefined &&
      (record(spec["env"]) === null ||
        Object.keys(spec["env"] as Record<string, unknown>).length >
          MAX_PROGRAM_ENV_ENTRIES ||
        Object.entries(spec["env"] as Record<string, unknown>).some(
          ([key, entry]) =>
            !withinBytes(key, MAX_PROGRAM_ENV_KEY_BYTES) ||
            typeof entry !== "string" ||
            !withinBytes(entry, MAX_PROGRAM_ENV_VALUE_BYTES),
        ) ||
        Object.entries(spec["env"] as Record<string, unknown>).reduce(
          (total, [key, entry]) =>
            total +
            utf8Bytes(key) +
            (typeof entry === "string" ? utf8Bytes(entry) : 0),
          0,
        ) > MAX_PROGRAM_ENV_BYTES)) ||
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
    !string(match["regex"], MAX_PROGRAM_MATCH_REGEX_BYTES) ||
    (match["flags"] !== undefined &&
      !string(match["flags"], MAX_PROGRAM_FLAGS_BYTES))
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
    string(outcome["invocationId"], MAX_ID_BYTES) &&
    nullableString(outcome["output"], 8_000) &&
    nullableNumber(outcome["exitCode"]) &&
    nullableString(outcome["error"], MAX_ERROR_BYTES)
  );
}

function isRoom(value: unknown): value is ZenXRoom {
  const room = record(value);
  if (
    room === null ||
    !string(room["id"], MAX_ID_BYTES) ||
    !string(room["name"], MAX_ROOM_NAME_BYTES) ||
    !arrayOf(room["members"], isRoomMember, MAX_ROOM_MEMBERS) ||
    !arrayOf(room["messages"], isRoomMessage, MAX_ROOM_MESSAGES) ||
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
    member !== null &&
    string(member["name"], MAX_MEMBER_NAME_BYTES) &&
    string(member["threadId"], MAX_ID_BYTES)
  );
}

function isRoomMessage(value: unknown): value is RoomMessage {
  const message = record(value);
  return (
    message !== null &&
    string(message["id"], MAX_ID_BYTES) &&
    string(message["roomId"], MAX_ID_BYTES) &&
    string(message["author"], MAX_MESSAGE_AUTHOR_BYTES) &&
    string(message["text"], MAX_MESSAGE_TEXT_BYTES) &&
    finiteNumber(message["createdAt"]) &&
    (message["kind"] === "human" ||
      message["kind"] === "agent" ||
      message["kind"] === "system") &&
    nullableString(message["originThreadId"], MAX_ID_BYTES) &&
    nullableString(message["originTurnId"], MAX_ID_BYTES)
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
  maximum?: number,
): value is T[] {
  return (
    Array.isArray(value) &&
    (maximum === undefined || value.length <= maximum) &&
    value.every(predicate)
  );
}

function string(value: unknown, maximum = MAX_ID_BYTES): value is string {
  return (
    typeof value === "string" && value.length > 0 && withinBytes(value, maximum)
  );
}

function nullableString(
  value: unknown,
  maximum = MAX_ID_BYTES,
): value is string | null {
  return value === null || string(value, maximum);
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

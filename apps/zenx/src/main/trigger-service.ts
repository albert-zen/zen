import { createHash, randomUUID } from "node:crypto";

import type {
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
  ThreadItem,
  Turn,
} from "../protocol-client/index.js";
import { ZenXTriggerStore } from "./trigger-store.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  UpdateTriggerInput,
  RoomMember,
  RoomMessage,
  TriggerHistoryEntry,
  TriggerSnapshot,
  ZenXRoom,
  ZenXTrigger,
} from "./trigger-types.js";

export interface ZenXTriggerAppServerPort {
  request(
    method: "turn/start",
    params: ClientRequestParams["turn/start"],
  ): Promise<ClientRequestResults["turn/start"]>;
  onNotification(
    listener: (
      method: ServerNotificationMethod,
      params: ServerNotificationParams[ServerNotificationMethod],
    ) => void,
  ): () => void;
}

export interface ZenXTriggerTitlePort {
  observe(threadId: string, input: string): Promise<unknown>;
}

export class ZenXTriggerService {
  readonly #manager: ZenXTriggerAppServerPort;
  readonly #store: ZenXTriggerStore;
  readonly #titles: ZenXTriggerTitlePort | undefined;
  readonly #listeners = new Set<(snapshot: TriggerSnapshot) => void>();
  readonly #timers = new Map<string, unknown>();
  readonly #completedAgentMessages = new Map<string, string>();
  readonly #completedTurnItems = new Map<string, ThreadItem[]>();
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  #snapshot: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  #mutation: Promise<void> = Promise.resolve();

  constructor(
    manager: ZenXTriggerAppServerPort,
    store: ZenXTriggerStore,
    options: {
      now?: () => number;
      schedule?: (callback: () => void, delayMs: number) => unknown;
      cancelScheduled?: (handle: unknown) => void;
      titles?: ZenXTriggerTitlePort;
    } = {},
  ) {
    this.#manager = manager;
    this.#store = store;
    this.#titles = options.titles;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async start(): Promise<void> {
    this.#snapshot = await this.#store.read();
    for (const entry of this.#snapshot.history) {
      if (entry.status === "starting" || entry.status === "running") {
        entry.status = "failed";
        entry.completedAt = this.#now();
        entry.error =
          "ZenX stopped before this wakeup reached a visible terminal result; it was not retried.";
      }
    }
    await this.#persist();
    this.#rescheduleTimers();
    this.#manager.onNotification((method, params) => {
      if (method === "item/completed") {
        const event = params as ServerNotificationParams["item/completed"];
        const items = this.#completedTurnItems.get(event.turnId) ?? [];
        const next = items.filter((item) => item.id !== event.item.id);
        next.push(event.item);
        this.#completedTurnItems.set(event.turnId, next);
        if (event.item.type === "agentMessage") {
          this.#completedAgentMessages.set(event.turnId, event.item.text);
        }
      } else if (method === "turn/completed") {
        void this.#handleTurnCompleted(
          params as ServerNotificationParams["turn/completed"],
        );
      }
    });
  }

  stop(): void {
    for (const timer of this.#timers.values()) this.#cancelScheduled(timer);
    this.#timers.clear();
  }
  snapshot(): TriggerSnapshot {
    return structuredClone(this.#snapshot);
  }
  onChange(listener: (snapshot: TriggerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async create(input: CreateTriggerInput): Promise<ZenXTrigger> {
    return await this.#mutate(async () => {
      const common = {
        id: randomUUID(),
        threadId: required(input.threadId, "thread"),
        kind: input.kind,
        label: required(input.label, "label"),
        prompt: required(input.prompt, "prompt"),
        createdAt: this.#now(),
        active: true,
      };
      const trigger: ZenXTrigger =
        input.kind === "timer"
          ? {
              ...common,
              timer: {
                nextRunAt: validFuture(input.runAt, this.#now()),
                intervalMinutes:
                  input.intervalMinutes === undefined
                    ? null
                    : positive(input.intervalMinutes),
              },
            }
          : input.kind === "thread"
            ? {
                ...common,
                watch: {
                  threadId: required(input.watchedThreadId, "watched thread"),
                  event: "turn_completed",
                },
              }
            : input.kind === "roomMention"
              ? {
                  ...common,
                  room: {
                    roomId: required(input.roomId, "room"),
                    mention: required(input.mention, "mention"),
                  },
                }
              : {
                  ...common,
                  signal: { name: required(input.signalName, "signal name") },
                };
      this.#snapshot.triggers.push(trigger);
      return trigger;
    }).then((trigger) => {
      this.#rescheduleTimers();
      return trigger;
    });
  }

  async cancel(triggerId: string): Promise<void> {
    await this.#mutate(async () => {
      const trigger = this.#snapshot.triggers.find(
        (item) => item.id === triggerId,
      );
      if (trigger === undefined) throw new Error("Trigger was not found");
      trigger.active = false;
      const timer = this.#timers.get(trigger.id);
      if (timer !== undefined) this.#cancelScheduled(timer);
      this.#timers.delete(trigger.id);
    });
  }

  async update(input: UpdateTriggerInput): Promise<ZenXTrigger> {
    const replacement = await this.#mutate(async () => {
      const index = this.#snapshot.triggers.findIndex(
        (item) => item.id === input.id,
      );
      if (index < 0) throw new Error("Trigger was not found");
      const existing = this.#snapshot.triggers[index]!;
      const replacement = triggerFromInput(
        input,
        existing.id,
        existing.createdAt,
        existing.active,
        this.#now(),
      );
      this.#snapshot.triggers[index] = replacement;
      return replacement;
    });
    this.#rescheduleTimers();
    return replacement;
  }

  async delete(triggerId: string): Promise<void> {
    await this.#mutate(async () => {
      const index = this.#snapshot.triggers.findIndex(
        (item) => item.id === required(triggerId, "trigger"),
      );
      if (index < 0) throw new Error("Trigger was not found");
      this.#snapshot.triggers.splice(index, 1);
    });
    const timer = this.#timers.get(triggerId);
    if (timer !== undefined) this.#cancelScheduled(timer);
    this.#timers.delete(triggerId);
  }

  async signal(name: string, detail: string): Promise<void> {
    const signalName = required(name, "signal name");
    const signalDetail = detail.trim();
    const matches = this.#snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.kind === "signal" &&
        trigger.signal?.name === signalName,
    );
    for (const trigger of matches)
      await this.#fire(trigger.id, {
        reason: `External signal ${signalName}: ${signalDetail}`,
        occurrenceKey: `signal:${randomUUID()}`,
        projection: `Signal name: ${signalName}\nSignal detail: ${bounded(signalDetail, 4_000)}`,
      });
  }

  async createRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    return await this.#mutate(async () => {
      const members = validateMembers(input.members);
      const room: ZenXRoom = {
        id: randomUUID(),
        name: required(input.name, "room name"),
        members,
        messages: [],
        createdAt: this.#now(),
      };
      this.#snapshot.rooms.push(room);
      return room;
    });
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    await this.#mutate(async () => {
      const room = this.#snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      room.name = required(name, "room name");
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.#mutate(async () => {
      const normalized = required(roomId, "room");
      if (
        this.#snapshot.triggers.some(
          (trigger) => trigger.active && trigger.room?.roomId === normalized,
        )
      ) {
        throw new Error(
          "Room has active mention triggers; cancel or delete them first",
        );
      }
      const index = this.#snapshot.rooms.findIndex(
        (entry) => entry.id === normalized,
      );
      if (index < 0) throw new Error("Room was not found");
      this.#snapshot.rooms.splice(index, 1);
    });
  }

  async addRoomMember(roomId: string, member: RoomMember): Promise<void> {
    await this.#mutate(async () => {
      const room = this.#snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      room.members = validateMembers([...room.members, member]);
    });
  }

  async removeRoomMember(roomId: string, threadId: string): Promise<void> {
    await this.#mutate(async () => {
      const room = this.#snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      const normalizedThreadId = required(threadId, "member thread");
      if (
        !room.members.some((member) => member.threadId === normalizedThreadId)
      )
        throw new Error("Room member was not found");
      room.members = room.members.filter(
        (member) => member.threadId !== normalizedThreadId,
      );
    });
  }

  async postRoomMessage(
    roomId: string,
    author: string,
    text: string,
  ): Promise<void> {
    await this.#postRoomMessage(roomId, author, text, "human");
  }

  async postAgentRoomMessage(roomId: string, text: string): Promise<void> {
    await this.#postRoomMessage(roomId, "ZenX Agent", text, "agent");
  }

  async #postRoomMessage(
    roomId: string,
    author: string,
    text: string,
    kind: "human" | "agent",
  ): Promise<void> {
    const { posted, room } = await this.#mutate(async () => {
      const room = this.#snapshot.rooms.find((entry) => entry.id === roomId);
      if (room === undefined) throw new Error("Room was not found");
      const posted = message(
        room.id,
        required(author, "author"),
        required(text, "message"),
        kind,
        null,
        null,
        this.#now(),
      );
      room.messages.push(posted);
      return { posted, room: structuredClone(room) };
    });
    const mentions = room.members.filter((member) =>
      new RegExp(
        `(^|\\s)@${escapeRegExp(member.name)}(?=\\s|$|[,.!?])`,
        "iu",
      ).test(text),
    );
    for (const member of mentions) {
      const matches = this.#snapshot.triggers.filter(
        (trigger) =>
          trigger.active &&
          trigger.threadId === member.threadId &&
          trigger.kind === "roomMention" &&
          trigger.room?.roomId === roomId &&
          trigger.room.mention.toLocaleLowerCase() ===
            member.name.toLocaleLowerCase(),
      );
      for (const trigger of matches)
        await this.#fire(trigger.id, {
          reason: `Room #${room.name} mention from ${posted.author}: ${posted.text}`,
          occurrenceKey: `room:${room.id}:${posted.id}`,
          sourceRoomId: room.id,
          sourceRoomMessageId: posted.id,
          projection: projectRoomContext(room),
        });
    }
  }

  async #handleTurnCompleted(
    event: ServerNotificationParams["turn/completed"],
  ): Promise<void> {
    const completedItems = mergeCompletedItems(
      event.turn.items,
      this.#completedTurnItems.get(event.turn.id) ?? [],
    );
    await this.#mutate(async () => {
      const entry = this.#snapshot.history.find(
        (item) => item.turnId === event.turn.id && item.status === "running",
      );
      if (entry !== undefined) {
        entry.status =
          event.turn.status === "completed" ? "completed" : "failed";
        entry.completedAt = this.#now();
        entry.error = event.turn.error?.message ?? null;
        if (entry.replyRoomId !== null && entry.replyAuthor !== null) {
          const room = this.#snapshot.rooms.find(
            (item) => item.id === entry.replyRoomId,
          );
          const projectedAnswer = [...completedItems]
            .reverse()
            .find((item) => item.type === "agentMessage");
          const answer =
            projectedAnswer?.type === "agentMessage"
              ? projectedAnswer.text
              : (this.#completedAgentMessages.get(event.turn.id) ?? "");
          if (room !== undefined && answer.length > 0) {
            room.messages.push(
              message(
                room.id,
                entry.replyAuthor,
                answer,
                "agent",
                entry.threadId,
                event.turn.id,
                this.#now(),
              ),
            );
          }
        }
      }
    });
    this.#completedAgentMessages.delete(event.turn.id);
    this.#completedTurnItems.delete(event.turn.id);
    const watchers = this.#snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.kind === "thread" &&
        trigger.watch?.threadId === event.threadId,
    );
    for (const trigger of watchers)
      await this.#fire(trigger.id, {
        reason: `Thread ${event.threadId} emitted turn_completed for ${event.turn.id}`,
        occurrenceKey: `thread:${event.threadId}:${event.turn.id}`,
        sourceThreadId: event.threadId,
        sourceTurnId: event.turn.id,
        projection: projectCompletedTurn(event.threadId, {
          ...event.turn,
          items: completedItems,
        }),
      });
  }

  async #fire(
    triggerId: string,
    wakeup: {
      reason: string;
      occurrenceKey: string;
      projection?: string;
      sourceThreadId?: string;
      sourceTurnId?: string;
      sourceRoomId?: string;
      sourceRoomMessageId?: string;
      scheduledAt?: number;
    },
  ): Promise<void> {
    const committed = await this.#mutate(async () => {
      const trigger = this.#snapshot.triggers.find(
        (item) => item.id === triggerId && item.active,
      );
      if (trigger === undefined) return undefined;
      const clientUserMessageId = stableWakeupId(
        trigger.id,
        wakeup.occurrenceKey,
      );
      if (
        this.#snapshot.history.some(
          (entry) => entry.clientUserMessageId === clientUserMessageId,
        )
      )
        return undefined;
      const committedTrigger = structuredClone(trigger);
      const history: TriggerHistoryEntry = {
        id: randomUUID(),
        triggerId: committedTrigger.id,
        threadId: committedTrigger.threadId,
        kind: committedTrigger.kind,
        reason: wakeup.reason,
        prompt: committedTrigger.prompt,
        clientUserMessageId,
        startedAt: this.#now(),
        completedAt: null,
        status: "starting",
        turnId: null,
        error: null,
        sourceThreadId: wakeup.sourceThreadId ?? null,
        sourceTurnId: wakeup.sourceTurnId ?? null,
        sourceRoomId: wakeup.sourceRoomId ?? null,
        sourceRoomMessageId: wakeup.sourceRoomMessageId ?? null,
        replyRoomId: committedTrigger.room?.roomId ?? null,
        replyAuthor: committedTrigger.room?.mention ?? null,
      };
      this.#snapshot.history.unshift(history);
      const currentTrigger = this.#snapshot.triggers.find(
        (item) => item.id === committedTrigger.id,
      );
      if (currentTrigger?.timer !== undefined) {
        if (currentTrigger.timer.intervalMinutes === null)
          currentTrigger.active = false;
        else
          currentTrigger.timer.nextRunAt =
            Math.max(this.#now(), wakeup.scheduledAt ?? this.#now()) +
            currentTrigger.timer.intervalMinutes * 60_000;
      }
      return {
        trigger: committedTrigger,
        history,
        clientUserMessageId,
      };
    });
    if (committed === undefined) return;
    const { trigger, history, clientUserMessageId } = committed;
    this.#rescheduleTimers();
    try {
      await this.#titles
        ?.observe(
          trigger.threadId,
          meaningfulWakeupTitleInput(trigger, wakeup.projection),
        )
        .catch((error: unknown) =>
          console.warn(
            `Could not stage trigger title: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      const result = await this.#manager.request("turn/start", {
        threadId: trigger.threadId,
        clientUserMessageId,
        input: [
          {
            type: "text",
            text: wakeupInput(trigger, history, wakeup.projection),
          },
        ],
      });
      await this.#mutate(async () => {
        history.status = "running";
        history.turnId = result.turn.id;
      });
    } catch (error) {
      await this.#mutate(async () => {
        history.status = "failed";
        history.completedAt = this.#now();
        history.error = error instanceof Error ? error.message : String(error);
      });
    }
  }

  #rescheduleTimers(): void {
    for (const timer of this.#timers.values()) this.#cancelScheduled(timer);
    this.#timers.clear();
    for (const trigger of this.#snapshot.triggers) {
      if (!trigger.active || trigger.timer === undefined) continue;
      this.#scheduleTimer(trigger.id, trigger.timer.nextRunAt);
    }
  }

  #scheduleTimer(triggerId: string, scheduledAt: number): void {
    const delay = Math.max(
      0,
      Math.min(2_147_000_000, scheduledAt - this.#now()),
    );
    const timer = this.#schedule(() => {
      this.#timers.delete(triggerId);
      if (this.#now() < scheduledAt) {
        this.#scheduleTimer(triggerId, scheduledAt);
        return;
      }
      void this.#fire(triggerId, {
        reason: `Timer reached ${new Date(scheduledAt).toISOString()}`,
        occurrenceKey: `timer:${scheduledAt}`,
        scheduledAt,
      });
    }, delay);
    this.#timers.set(triggerId, timer);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const previousSnapshot = structuredClone(this.#snapshot);
    try {
      const result = await operation();
      await this.#persist();
      return result;
    } catch (error) {
      this.#snapshot = previousSnapshot;
      throw error;
    } finally {
      release();
    }
  }

  async #persist(): Promise<void> {
    await this.#store.write(this.#snapshot);
    for (const listener of this.#listeners) listener(this.snapshot());
  }
}

function meaningfulWakeupTitleInput(
  trigger: ZenXTrigger,
  projection?: string,
): string {
  return [
    `Trigger: ${trigger.label}`,
    `Task: ${trigger.prompt}`,
    ...(projection === undefined
      ? []
      : [`Source context: ${bounded(projection, 1_200)}`]),
  ].join("\n");
}

function message(
  roomId: string,
  author: string,
  text: string,
  kind: RoomMessage["kind"],
  originThreadId: string | null,
  originTurnId: string | null,
  createdAt: number,
): RoomMessage {
  return {
    id: randomUUID(),
    roomId,
    author,
    text,
    createdAt,
    kind,
    originThreadId,
    originTurnId,
  };
}
function required(value: string, label: string): string {
  if (value.trim().length === 0)
    throw new Error(`Trigger ${label} is required`);
  return value.trim();
}
function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Timer interval must be positive");
  return value;
}
function validFuture(value: number, now: number): number {
  if (!Number.isFinite(value) || value <= now)
    throw new Error("Timer must be scheduled in the future");
  return value;
}

function triggerFromInput(
  input: CreateTriggerInput,
  id: string,
  createdAt: number,
  active: boolean,
  now: number,
): ZenXTrigger {
  const common = {
    id,
    threadId: required(input.threadId, "thread"),
    kind: input.kind,
    label: required(input.label, "label"),
    prompt: required(input.prompt, "prompt"),
    createdAt,
    active,
  };
  if (input.kind === "timer") {
    return {
      ...common,
      kind: "timer",
      timer: {
        nextRunAt: validFuture(input.runAt, now),
        intervalMinutes:
          input.intervalMinutes === undefined
            ? null
            : positive(input.intervalMinutes),
      },
    };
  }
  if (input.kind === "thread") {
    return {
      ...common,
      kind: "thread",
      watch: {
        threadId: required(input.watchedThreadId, "watched thread"),
        event: "turn_completed",
      },
    };
  }
  if (input.kind === "roomMention") {
    return {
      ...common,
      kind: "roomMention",
      room: {
        roomId: required(input.roomId, "room"),
        mention: required(input.mention, "mention"),
      },
    };
  }
  return {
    ...common,
    kind: "signal",
    signal: { name: required(input.signalName, "signal name") },
  };
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateMembers(members: readonly RoomMember[]): RoomMember[] {
  if (members.length === 0) throw new Error("Room needs at least one member");
  const normalized = members.map((member) => ({
    name: required(member.name, "member name"),
    threadId: required(member.threadId, "member thread"),
  }));
  const names = new Set<string>();
  const threads = new Set<string>();
  for (const member of normalized) {
    const name = member.name.toLocaleLowerCase();
    if (names.has(name))
      throw new Error(`Room member name @${member.name} is already in use`);
    if (threads.has(member.threadId))
      throw new Error(`Thread ${member.threadId} is already a Room member`);
    names.add(name);
    threads.add(member.threadId);
  }
  return normalized;
}

function stableWakeupId(triggerId: string, occurrenceKey: string): string {
  const occurrence = createHash("sha256")
    .update(occurrenceKey)
    .digest("hex")
    .slice(0, 24);
  return `zenx-wakeup:${triggerId}:${occurrence}`;
}

function wakeupInput(
  trigger: ZenXTrigger,
  history: TriggerHistoryEntry,
  projection?: string,
): string {
  const source = [
    history.sourceThreadId === null
      ? null
      : `Source Thread: ${history.sourceThreadId}`,
    history.sourceTurnId === null
      ? null
      : `Source Turn: ${history.sourceTurnId}`,
    history.sourceRoomId === null
      ? null
      : `Source Room: ${history.sourceRoomId}`,
    history.sourceRoomMessageId === null
      ? null
      : `Source Room message: ${history.sourceRoomMessageId}`,
  ].filter((line): line is string => line !== null);
  return [
    "[ZenX trigger wakeup]",
    `Trigger ID: ${trigger.id}`,
    `Reason: ${history.reason}`,
    ...source,
    `Registered trigger: ${trigger.label}`,
    "",
    "Injected prompt:",
    trigger.prompt,
    ...(projection === undefined
      ? []
      : ["", "Bounded source context (read-only projection):", projection]),
  ].join("\n");
}

export function projectCompletedTurn(threadId: string, turn: Turn): string {
  const userInputs = turn.items
    .filter((item) => item.type === "userMessage")
    .slice(-2)
    .map((item) =>
      bounded(item.content.map((content) => content.text).join("\n"), 1_200),
    );
  const conclusion = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage");
  const commands = turn.items
    .filter((item) => item.type === "commandExecution")
    .slice(-2)
    .map(
      (item) =>
        `$ ${bounded(item.command, 500)}\nStatus: ${item.status}${
          item.exitCode === null ? "" : ` (exit ${item.exitCode})`
        }\n${bounded(item.aggregatedOutput ?? "No captured output", 1_000)}`,
    );
  const sections = [
    `Source Thread: ${threadId}`,
    `Source Turn: ${turn.id}`,
    `Status: ${turn.status}`,
    userInputs.length === 0 ? null : `User input:\n${userInputs.join("\n\n")}`,
    commands.length === 0
      ? null
      : `Command/result summary:\n${commands.join("\n\n")}`,
    conclusion?.type === "agentMessage"
      ? `Agent conclusion:\n${bounded(conclusion.text, 1_800)}`
      : "Agent conclusion:\nNo final Agent message was emitted.",
  ].filter((section): section is string => section !== null);
  return bounded(sections.join("\n\n"), 6_000);
}

export function projectRoomContext(room: ZenXRoom): string {
  const recent = room.messages.slice(-8).map((entry) => {
    const origin =
      entry.originThreadId === null
        ? ""
        : ` [source Thread ${entry.originThreadId}, Turn ${entry.originTurnId ?? "unknown"}]`;
    return `${entry.author} (${entry.kind})${origin}: ${bounded(entry.text, 700)}`;
  });
  return bounded(
    [`Room #${room.name} (${room.id})`, "Recent Room context:", ...recent].join(
      "\n",
    ),
    6_000,
  );
}

function mergeCompletedItems(
  turnItems: readonly ThreadItem[],
  completedItems: readonly ThreadItem[],
): ThreadItem[] {
  const completed = new Map(completedItems.map((item) => [item.id, item]));
  const merged = turnItems.map((item) => completed.get(item.id) ?? item);
  const included = new Set(merged.map((item) => item.id));
  for (const item of completedItems) {
    if (!included.has(item.id)) merged.push(item);
  }
  return merged;
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 24))}\n…[truncated by ZenX]`;
}

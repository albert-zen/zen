import { createHash, randomUUID } from "node:crypto";

import type {
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
  ThreadItem,
  Turn,
} from "../protocol-client/index.js";
import {
  ZenXTriggerProgramRunner,
  type TriggerProgramRunner,
} from "./trigger-program-runner.js";
import { ZenXTriggerStore } from "./trigger-store.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  RoomMessage,
  TriggerHistoryEntry,
  TriggerProgramConfig,
  TriggerProgramOutcome,
  TriggerProgramSpec,
  TriggerSnapshot,
  UpdateTriggerInput,
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

const MAX_WAKEUPS = 64;
const MAX_TRANSIENT_TURNS = 64;
const MAX_ITEMS_PER_TURN = 64;
const MAX_PROGRAM_OUTCOMES = 4;

interface WakeupEvent {
  reason: string;
  occurrenceKey: string;
  projection?: string;
  eventText?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  sourceRoomId?: string;
  sourceRoomMessageId?: string;
  scheduledAt?: number;
}

interface ActiveWakeup {
  historyId: string;
  threadId: string;
  clientUserMessageId: string;
  trigger: ZenXTrigger;
  generationId: string;
}

interface CompletedItemBuffer {
  threadId: string;
  items: ThreadItem[];
}

interface PendingCompletion {
  event: ServerNotificationParams["turn/completed"];
  clientUserMessageId: string | null;
  rejected: boolean;
  claimed: boolean;
}

interface TriggerGeneration {
  id: string;
  active: boolean;
  retiring: boolean;
  timers: Map<string, unknown>;
  completedTurnItems: Map<string, CompletedItemBuffer>;
  pendingCompletedTurns: Map<string, PendingCompletion>;
  activeWakeups: Map<string, ActiveWakeup>;
  programControllers: Map<string, AbortController>;
  disposeNotifications: (() => void) | undefined;
}

export class ZenXTriggerService {
  readonly #manager: ZenXTriggerAppServerPort;
  readonly #store: ZenXTriggerStore;
  readonly #titles: ZenXTriggerTitlePort | undefined;
  readonly #programs: TriggerProgramRunner;
  readonly #listeners = new Set<(snapshot: TriggerSnapshot) => void>();
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  #snapshot: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  #mutation: Promise<void> = Promise.resolve();
  #generation: TriggerGeneration | null = null;

  constructor(
    manager: ZenXTriggerAppServerPort,
    store: ZenXTriggerStore,
    options: {
      now?: () => number;
      schedule?: (callback: () => void, delayMs: number) => unknown;
      cancelScheduled?: (handle: unknown) => void;
      titles?: ZenXTriggerTitlePort;
      programs?: TriggerProgramRunner;
    } = {},
  ) {
    this.#manager = manager;
    this.#store = store;
    this.#titles = options.titles;
    this.#programs = options.programs ?? new ZenXTriggerProgramRunner();
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async start(): Promise<void> {
    if (this.#generation !== null) await this.stop();
    const generation = newGeneration();
    this.#generation = generation;
    try {
      await this.#mutation;
      const snapshot = await this.#store.read();
      for (const entry of snapshot.history) {
        if (entry.status === "starting" || entry.status === "running") {
          entry.status = "failed";
          entry.completedAt = this.#now();
          entry.error =
            "ZenX stopped before this wakeup reached a visible terminal result; it was not retried.";
          if (entry.programInvocationId != null) {
            const outcome: TriggerProgramOutcome = {
              stage: programStageForInvocation(entry.programInvocationId),
              invocationId: entry.programInvocationId,
              status: "uncertain",
              output: null,
              exitCode: null,
              error:
                "The previous process ended before the local program outcome was known",
            };
            entry.programOutcome = outcome;
            entry.programOutcomes = [outcome];
          }
        }
      }
      await this.#store.write(snapshot);
      this.#assertMutationGeneration(generation);
      this.#snapshot = snapshot;
      this.#notify();
      this.#rescheduleTimers(generation);
      generation.disposeNotifications = this.#manager.onNotification(
        (method, params) => {
          if (!this.#isOperational(generation)) return;
          if (method === "item/completed") {
            this.#handleItemCompleted(
              generation,
              params as ServerNotificationParams["item/completed"],
            );
          } else if (method === "turn/completed") {
            void this.#handleTurnCompleted(
              generation,
              params as ServerNotificationParams["turn/completed"],
            ).catch((error: unknown) => {
              if (this.#isOperational(generation))
                console.warn(
                  `Could not process Trigger completion: ${describeError(error)}`,
                );
            });
          }
        },
      );
    } catch (error) {
      generation.active = false;
      if (this.#generation === generation) this.#generation = null;
      generation.disposeNotifications?.();
      generation.disposeNotifications = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const generation = this.#generation;
    if (generation === null) return;
    generation.retiring = true;
    for (const controller of generation.programControllers.values())
      controller.abort();
    try {
      await this.#mutate(
        generation,
        async (snapshot) => {
          for (const entry of snapshot.history) {
            if (isTerminal(entry.status)) continue;
            entry.status = "failed";
            entry.completedAt = this.#now();
            entry.error =
              "ZenX Trigger generation retired before this wakeup reached a visible terminal result; it was not retried.";
            if (entry.programInvocationId != null) {
              const outcome: TriggerProgramOutcome = {
                stage: programStageForInvocation(entry.programInvocationId),
                invocationId: entry.programInvocationId,
                status: "uncertain",
                output: null,
                exitCode: null,
                error:
                  "Trigger generation retired while local work was in flight",
              };
              entry.programOutcome = outcome;
              entry.programOutcomes = [
                ...(entry.programOutcomes ?? []),
                outcome,
              ].slice(-MAX_PROGRAM_OUTCOMES);
            }
          }
          generation.activeWakeups.clear();
          return undefined;
        },
        true,
      );
    } finally {
      generation.active = false;
      if (this.#generation === generation) this.#generation = null;
      generation.disposeNotifications?.();
      generation.disposeNotifications = undefined;
      for (const timer of generation.timers.values())
        this.#cancelScheduled(timer);
      generation.timers.clear();
      generation.completedTurnItems.clear();
      generation.pendingCompletedTurns.clear();
      generation.activeWakeups.clear();
      generation.programControllers.clear();
    }
  }

  async close(): Promise<void> {
    await this.stop();
    this.#listeners.clear();
  }

  snapshot(): TriggerSnapshot {
    return structuredClone(this.#snapshot);
  }

  onChange(listener: (snapshot: TriggerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async create(input: CreateTriggerInput): Promise<ZenXTrigger> {
    const generation = this.#runningGeneration();
    const trigger = await this.#mutate(generation, async (snapshot) => {
      const value = triggerFromInput(
        input,
        randomUUID(),
        this.#now(),
        true,
        this.#now(),
      );
      snapshot.triggers.push(value);
      return value;
    });
    this.#rescheduleTimers(generation);
    return structuredClone(trigger);
  }

  async update(input: UpdateTriggerInput): Promise<ZenXTrigger> {
    const generation = this.#runningGeneration();
    const trigger = await this.#mutate(generation, async (snapshot) => {
      const index = snapshot.triggers.findIndex(
        (candidate) => candidate.id === input.id,
      );
      if (index < 0) throw new Error("Trigger was not found");
      const existing = snapshot.triggers[index]!;
      const replacement = triggerFromInput(
        input,
        existing.id,
        existing.createdAt,
        existing.active,
        this.#now(),
      );
      snapshot.triggers[index] = replacement;
      return replacement;
    });
    this.#rescheduleTimers(generation);
    return structuredClone(trigger);
  }

  async cancel(triggerId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const trigger = snapshot.triggers.find(
        (item) => item.id === required(triggerId, "trigger"),
      );
      if (trigger === undefined) throw new Error("Trigger was not found");
      trigger.active = false;
      const timer = generation.timers.get(trigger.id);
      if (timer !== undefined) this.#cancelScheduled(timer);
      generation.timers.delete(trigger.id);
    });
  }

  async delete(triggerId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const normalized = required(triggerId, "trigger");
      const index = snapshot.triggers.findIndex(
        (item) => item.id === normalized,
      );
      if (index < 0) throw new Error("Trigger was not found");
      snapshot.triggers.splice(index, 1);
      const timer = generation.timers.get(normalized);
      if (timer !== undefined) this.#cancelScheduled(timer);
      generation.timers.delete(normalized);
    });
  }

  async signal(name: string, detail: string): Promise<void> {
    const generation = this.#runningGeneration();
    const signalName = required(name, "signal name");
    const signalDetail = detail.trim();
    const matches = this.#snapshot.triggers
      .filter(
        (trigger) =>
          trigger.active &&
          trigger.kind === "signal" &&
          trigger.signal?.name === signalName,
      )
      .map((trigger) => trigger.id);
    for (const triggerId of matches) {
      await this.#fire(generation, triggerId, {
        reason: `External signal ${signalName}: ${bounded(signalDetail, 4_000)}`,
        occurrenceKey: `signal:${randomUUID()}`,
        projection: `Signal name: ${signalName}\nSignal detail: ${bounded(signalDetail, 4_000)}`,
      });
    }
  }

  async createRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    const generation = this.#runningGeneration();
    const room = await this.#mutate(generation, async (snapshot) => {
      const value: ZenXRoom = {
        id: randomUUID(),
        name: required(input.name, "room name"),
        members: validateMembers(input.members),
        messages: [],
        createdAt: this.#now(),
      };
      snapshot.rooms.push(value);
      return value;
    });
    return structuredClone(room);
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (candidate) => candidate.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      room.name = required(name, "room name");
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const normalized = required(roomId, "room");
      const room = snapshot.rooms.find(
        (candidate) => candidate.id === normalized,
      );
      if (room === undefined) throw new Error("Room was not found");
      const owner = snapshot.history.find(
        (entry) =>
          entry.replyRoomId === normalized &&
          (entry.status === "starting" || entry.status === "running"),
      );
      if (owner !== undefined)
        throw new Error(
          "Room cannot be deleted while a nonterminal wakeup owns its reply route",
        );
      snapshot.rooms = snapshot.rooms.filter(
        (candidate) => candidate.id !== normalized,
      );
    });
  }

  async addRoomMember(roomId: string, member: RoomMember): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      room.members = validateMembers([...room.members, member]);
    });
  }

  async removeRoomMember(roomId: string, threadId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      const normalized = required(threadId, "member thread");
      if (!room.members.some((member) => member.threadId === normalized))
        throw new Error("Room member was not found");
      room.members = room.members.filter(
        (member) => member.threadId !== normalized,
      );
    });
  }

  async postRoomMessage(
    roomId: string,
    author: string,
    text: string,
  ): Promise<void> {
    await this.#postRoomMessage(roomId, author, text, "human", null, null);
  }

  async postAgentRoomMessage(roomId: string, text: string): Promise<void> {
    await this.#postRoomMessage(roomId, "Agent", text, "agent", null, null);
  }

  async #postRoomMessage(
    roomId: string,
    author: string,
    text: string,
    kind: RoomMessage["kind"],
    originThreadId: string | null,
    originTurnId: string | null,
  ): Promise<void> {
    const generation = this.#runningGeneration();
    const posted = await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room"),
      );
      if (room === undefined) throw new Error("Room was not found");
      const value = message(
        room.id,
        required(author, "author"),
        required(text, "message"),
        kind,
        originThreadId,
        originTurnId,
        this.#now(),
      );
      room.messages.push(value);
      return { posted: value, room: structuredClone(room) };
    });
    const mentions = posted.room.members.filter((member) =>
      mentionMatches(text, member.name),
    );
    for (const member of mentions) {
      const triggerIds = this.#snapshot.triggers
        .filter(
          (trigger) =>
            trigger.active &&
            trigger.threadId === member.threadId &&
            trigger.kind === "roomMention" &&
            trigger.room?.roomId === roomId &&
            trigger.room.mention.toLocaleLowerCase() ===
              member.name.toLocaleLowerCase(),
        )
        .map((trigger) => trigger.id);
      for (const triggerId of triggerIds) {
        await this.#fire(generation, triggerId, {
          reason: `Room #${posted.room.name} mention from ${posted.posted.author}: ${posted.posted.text}`,
          occurrenceKey: `room:${posted.room.id}:${posted.posted.id}`,
          sourceRoomId: posted.room.id,
          sourceRoomMessageId: posted.posted.id,
          projection: projectRoomContext(posted.room),
          eventText: posted.posted.text,
        });
      }
    }
  }

  async #handleTurnCompleted(
    generation: TriggerGeneration,
    event: ServerNotificationParams["turn/completed"],
  ): Promise<void> {
    if (!this.#isOperational(generation)) return;
    const key = transientTurnKey(event.threadId, event.turn.id);
    const buffered = generation.completedTurnItems.get(key);
    const completedItems = mergeCompletedItems(
      event.turn.items,
      buffered?.threadId === event.threadId ? buffered.items : [],
    );
    const running = this.#snapshot.history.find(
      (entry) =>
        entry.threadId === event.threadId &&
        entry.turnId === event.turn.id &&
        (entry.status === "starting" || entry.status === "running") &&
        generation.activeWakeups.has(entry.clientUserMessageId),
    );
    if (running !== undefined) {
      await this.#completeTurn(generation, running.id, event, completedItems);
      clearTransientTurn(generation, event.threadId, event.turn.id);
    } else {
      this.#bufferEarlyCompletion(generation, event, completedItems);
    }
    if (!this.#isOperational(generation)) return;
    const watchers = this.#snapshot.triggers
      .filter(
        (trigger) =>
          trigger.active &&
          trigger.kind === "thread" &&
          trigger.watch?.threadId === event.threadId,
      )
      .map((trigger) => trigger.id);
    for (const triggerId of watchers) {
      await this.#fire(generation, triggerId, {
        reason: `Thread ${event.threadId} emitted turn_completed for ${event.turn.id}`,
        occurrenceKey: `thread:${event.threadId}:${event.turn.id}`,
        sourceThreadId: event.threadId,
        sourceTurnId: event.turn.id,
        projection: projectCompletedTurn(event.threadId, {
          ...event.turn,
          items: completedItems,
        }),
        eventText: projectCompletedTurn(event.threadId, {
          ...event.turn,
          items: completedItems,
        }),
      });
    }
  }

  #handleItemCompleted(
    generation: TriggerGeneration,
    event: ServerNotificationParams["item/completed"],
  ): void {
    if (!this.#isOperational(generation)) return;
    if (!this.#isPotentialTurn(generation, event.threadId, event.turnId))
      return;
    const key = transientTurnKey(event.threadId, event.turnId);
    const current = generation.completedTurnItems.get(key);
    const items = (current?.items ?? []).filter(
      (item) => item.id !== event.item.id,
    );
    items.push(event.item);
    setBounded(
      generation.completedTurnItems,
      key,
      { threadId: event.threadId, items: items.slice(-MAX_ITEMS_PER_TURN) },
      (evicted) => generation.pendingCompletedTurns.delete(evicted),
    );
  }

  #isPotentialTurn(
    generation: TriggerGeneration,
    threadId: string,
    turnId: string,
  ): boolean {
    const key = transientTurnKey(threadId, turnId);
    return (
      generation.completedTurnItems.has(key) ||
      generation.pendingCompletedTurns.has(key) ||
      [...generation.activeWakeups.values()].some(
        (entry) => entry.threadId === threadId,
      ) ||
      this.#snapshot.triggers.some(
        (trigger) =>
          trigger.active &&
          trigger.kind === "thread" &&
          trigger.watch?.threadId === threadId,
      )
    );
  }

  #bufferEarlyCompletion(
    generation: TriggerGeneration,
    event: ServerNotificationParams["turn/completed"],
    completedItems: readonly ThreadItem[],
  ): void {
    const candidates = [...generation.activeWakeups.values()].filter(
      (entry) =>
        entry.threadId === event.threadId &&
        this.#snapshot.history.find((history) => history.id === entry.historyId)
          ?.status === "starting" &&
        this.#snapshot.history.find((history) => history.id === entry.historyId)
          ?.turnId === null,
    );
    if (candidates.length === 0) return;
    const key = transientTurnKey(event.threadId, event.turn.id);
    const existing = generation.pendingCompletedTurns.get(key);
    if (existing?.claimed || existing?.rejected) return;
    const clientIds = [
      ...new Set(
        completedItems
          .filter(
            (item): item is Extract<ThreadItem, { type: "userMessage" }> =>
              item.type === "userMessage",
          )
          .map((item) => item.clientId)
          .filter((value): value is string => value !== null),
      ),
    ];
    const exact =
      clientIds.length === 1 &&
      candidates.some((entry) => entry.clientUserMessageId === clientIds[0])
        ? clientIds[0]!
        : null;
    if (existing !== undefined) {
      if (exact !== null && existing.clientUserMessageId === exact) return;
      existing.rejected = true;
      existing.clientUserMessageId = null;
      return;
    }
    setBounded(
      generation.pendingCompletedTurns,
      key,
      {
        event,
        clientUserMessageId: exact,
        rejected: exact === null,
        claimed: false,
      },
      (evicted) => generation.completedTurnItems.delete(evicted),
    );
  }

  async #fire(
    generation: TriggerGeneration,
    triggerId: string,
    wakeup: WakeupEvent,
  ): Promise<void> {
    if (!this.#isOperational(generation)) return;
    let committed;
    try {
      committed = await this.#mutate(generation, async (snapshot) => {
        const trigger = snapshot.triggers.find(
          (item) => item.id === triggerId && item.active,
        );
        if (trigger === undefined) return undefined;
        if (
          trigger.kind === "roomMention" &&
          (trigger.room === undefined ||
            !snapshot.rooms.some((room) => room.id === trigger.room?.roomId))
        )
          return undefined;
        const clientUserMessageId = stableWakeupId(
          trigger.id,
          wakeup.occurrenceKey,
        );
        if (
          snapshot.history.some(
            (entry) => entry.clientUserMessageId === clientUserMessageId,
          )
        )
          return undefined;
        const nonterminal = snapshot.history.filter(
          (entry) => entry.status === "starting" || entry.status === "running",
        ).length;
        const rejected = nonterminal >= MAX_WAKEUPS;
        const history: TriggerHistoryEntry = {
          id: randomUUID(),
          triggerId: trigger.id,
          threadId: trigger.threadId,
          kind: trigger.kind,
          reason: bounded(wakeup.reason, 4_000),
          prompt: bounded(trigger.prompt, 4_000),
          clientUserMessageId,
          startedAt: this.#now(),
          completedAt: rejected ? this.#now() : null,
          status: rejected ? "failed" : "starting",
          turnId: null,
          error: rejected
            ? `ZenX Trigger wakeup admission is full at ${String(MAX_WAKEUPS)} nonterminal wakeups; this wakeup was not dispatched.`
            : null,
          sourceThreadId: wakeup.sourceThreadId ?? null,
          sourceTurnId: wakeup.sourceTurnId ?? null,
          sourceRoomId: wakeup.sourceRoomId ?? null,
          sourceRoomMessageId: wakeup.sourceRoomMessageId ?? null,
          replyRoomId: trigger.room?.roomId ?? null,
          replyAuthor: trigger.room?.mention ?? null,
          programInvocationId: null,
          programOutcome: null,
          programOutcomes: [],
        };
        snapshot.history.unshift(history);
        if (trigger.timer !== undefined) {
          if (trigger.timer.intervalMinutes === null) trigger.active = false;
          else {
            trigger.timer.nextRunAt =
              Math.max(this.#now(), wakeup.scheduledAt ?? this.#now()) +
              trigger.timer.intervalMinutes * 60_000;
          }
        }
        return rejected
          ? { rejected: true as const }
          : {
              rejected: false as const,
              trigger: structuredClone(trigger),
              historyId: history.id,
              clientUserMessageId,
            };
      });
    } catch (error) {
      if (error instanceof StaleGenerationError) return;
      throw error;
    }
    if (committed === undefined || committed.rejected) {
      this.#rescheduleTimers(generation);
      return;
    }
    this.#rescheduleTimers(generation);
    const active: ActiveWakeup = {
      historyId: committed.historyId,
      threadId: committed.trigger.threadId,
      clientUserMessageId: committed.clientUserMessageId,
      trigger: committed.trigger,
      generationId: generation.id,
    };
    generation.activeWakeups.set(active.clientUserMessageId, active);
    await this.#executeWakeup(generation, active, wakeup);
  }

  async #executeWakeup(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    wakeup: WakeupEvent,
  ): Promise<void> {
    const trigger = active.trigger;
    const controller = new AbortController();
    generation.programControllers.set(active.historyId, controller);
    try {
      await this.#observeTitle(trigger, wakeup.projection);
      if (!this.#isOperational(generation)) return;
      const program = trigger.program;
      if (program?.match !== undefined) {
        const regex = new RegExp(
          program.match.regex,
          program.match.flags ?? "u",
        );
        const matched = regex.test(wakeup.eventText ?? wakeup.projection ?? "");
        const outcome = this.#programOutcome(
          "predicate",
          stableProgramInvocationId(active.clientUserMessageId, "predicate"),
          matched ? "matched" : "non_match",
          null,
          null,
          null,
        );
        if (!matched) {
          await this.#finishProgram(
            generation,
            active,
            outcome,
            "completed",
            null,
          );
          return;
        }
        await this.#recordProgramOutcome(generation, active, outcome);
      }
      if (program?.predicate !== undefined) {
        const invocationId = stableProgramInvocationId(
          active.clientUserMessageId,
          "predicate",
        );
        await this.#recordProgramInvocation(generation, active, invocationId);
        const result = await this.#programs.run(
          program.predicate,
          {
            invocationId,
            stage: "predicate",
            event: programInput(active, wakeup),
          },
          controller.signal,
        );
        const outcome = this.#programOutcome(
          "predicate",
          invocationId,
          result.status,
          result.output,
          result.exitCode,
          result.error,
        );
        if (result.status !== "matched") {
          await this.#finishProgram(
            generation,
            active,
            outcome,
            result.status === "non_match" ? "completed" : "failed",
            result.status === "non_match" ? null : result.error,
          );
          return;
        }
        await this.#recordProgramOutcome(generation, active, outcome);
      }
      if (program?.action !== undefined) {
        const invocationId = stableProgramInvocationId(
          active.clientUserMessageId,
          "action",
        );
        await this.#recordProgramInvocation(generation, active, invocationId);
        const result = await this.#programs.run(
          program.action,
          {
            invocationId,
            stage: "action",
            event: programInput(active, wakeup),
          },
          controller.signal,
        );
        const outcome = this.#programOutcome(
          "action",
          invocationId,
          result.status,
          result.output,
          result.exitCode,
          result.error,
        );
        await this.#finishProgram(
          generation,
          active,
          outcome,
          result.status === "completed" ? "completed" : "failed",
          result.status === "completed" ? null : result.error,
        );
        return;
      }
      if (!this.#isOperational(generation)) return;
      const result = await this.#manager.request("turn/start", {
        threadId: trigger.threadId,
        clientUserMessageId: active.clientUserMessageId,
        input: [
          {
            type: "text",
            text: wakeupInput(
              trigger,
              this.#history(active.historyId),
              wakeup.projection,
            ),
          },
        ],
      });
      if (!this.#isOperational(generation)) return;
      const wasStarted = await this.#mutate(generation, async (snapshot) => {
        const history = snapshot.history.find(
          (entry) => entry.id === active.historyId,
        );
        if (history === undefined || history.status !== "starting")
          return false;
        const collision = snapshot.history.find(
          (entry) =>
            entry.id !== history.id &&
            entry.threadId === trigger.threadId &&
            entry.turnId === result.turn.id &&
            (entry.status === "starting" || entry.status === "running"),
        );
        if (collision !== undefined)
          throw new Error("Turn identity was already owned by another wakeup");
        history.status = "running";
        history.turnId = result.turn.id;
        return true;
      });
      if (!wasStarted) return;
      await this.#consumePendingCompletion(generation, active, result.turn.id);
      if (
        result.turn.status === "completed" ||
        result.turn.status === "interrupted"
      ) {
        await this.#completeTurn(
          generation,
          active.historyId,
          {
            threadId: trigger.threadId,
            turn: result.turn,
          },
          result.turn.items,
        );
      }
    } catch (error) {
      if (error instanceof StaleGenerationError) return;
      if (this.#isOperational(generation))
        await this.#failHistory(
          generation,
          active.historyId,
          describeError(error),
        );
    } finally {
      generation.programControllers.delete(active.historyId);
    }
  }

  async #consumePendingCompletion(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    turnId: string,
  ): Promise<void> {
    const key = transientTurnKey(active.threadId, turnId);
    const pending = generation.pendingCompletedTurns.get(key);
    if (
      pending === undefined ||
      pending.claimed ||
      pending.rejected ||
      pending.clientUserMessageId !== active.clientUserMessageId
    )
      return;
    pending.claimed = true;
    await this.#completeTurn(
      generation,
      active.historyId,
      pending.event,
      mergeCompletedItems(
        pending.event.turn.items,
        generation.completedTurnItems.get(key)?.items ?? [],
      ),
    );
    if (generation.pendingCompletedTurns.get(key) === pending)
      generation.pendingCompletedTurns.delete(key);
    generation.completedTurnItems.delete(key);
  }

  async #completeTurn(
    generation: TriggerGeneration,
    historyId: string,
    event: ServerNotificationParams["turn/completed"],
    completedItems: readonly ThreadItem[],
  ): Promise<void> {
    let released = false;
    await this.#mutate(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === historyId,
      );
      if (
        entry === undefined ||
        isTerminal(entry.status) ||
        entry.threadId !== event.threadId ||
        (entry.turnId !== null && entry.turnId !== event.turn.id)
      )
        return;
      entry.turnId = event.turn.id;
      entry.status = event.turn.status === "completed" ? "completed" : "failed";
      entry.completedAt = this.#now();
      entry.error = event.turn.error?.message ?? null;
      if (
        entry.status === "completed" &&
        entry.replyRoomId != null &&
        entry.replyAuthor != null
      ) {
        const room = snapshot.rooms.find(
          (candidate) => candidate.id === entry.replyRoomId,
        );
        const answer = [...completedItems]
          .reverse()
          .find((item) => item.type === "agentMessage");
        if (
          room !== undefined &&
          answer?.type === "agentMessage" &&
          answer.text.length > 0
        ) {
          room.messages.push(
            message(
              room.id,
              entry.replyAuthor,
              bounded(answer.text, 8_000),
              "agent",
              entry.threadId,
              event.turn.id,
              this.#now(),
            ),
          );
        }
      }
      released = true;
    });
    if (released) {
      const active = [...generation.activeWakeups.values()].find(
        (candidate) => candidate.historyId === historyId,
      );
      if (active !== undefined)
        generation.activeWakeups.delete(active.clientUserMessageId);
    }
  }

  async #recordProgramOutcome(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    outcome: TriggerProgramOutcome,
  ): Promise<void> {
    await this.#mutate(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === active.historyId,
      );
      if (entry === undefined || isTerminal(entry.status)) return;
      entry.programInvocationId = outcome.invocationId;
      entry.programOutcome = outcome;
      entry.programOutcomes = [...(entry.programOutcomes ?? []), outcome].slice(
        -MAX_PROGRAM_OUTCOMES,
      );
    });
  }

  async #recordProgramInvocation(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    invocationId: string,
  ): Promise<void> {
    await this.#mutate(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === active.historyId,
      );
      if (entry === undefined || isTerminal(entry.status)) return;
      entry.programInvocationId = invocationId;
    });
  }

  async #finishProgram(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    outcome: TriggerProgramOutcome,
    status: "completed" | "failed",
    error: string | null,
  ): Promise<void> {
    let released = false;
    await this.#mutate(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === active.historyId,
      );
      if (entry === undefined || isTerminal(entry.status)) return;
      entry.status = status;
      entry.completedAt = this.#now();
      entry.error = error;
      entry.programInvocationId = outcome.invocationId;
      entry.programOutcome = outcome;
      entry.programOutcomes = [...(entry.programOutcomes ?? []), outcome].slice(
        -MAX_PROGRAM_OUTCOMES,
      );
      released = true;
    });
    if (released) generation.activeWakeups.delete(active.clientUserMessageId);
  }

  async #failHistory(
    generation: TriggerGeneration,
    historyId: string,
    error: string,
  ): Promise<void> {
    let released = false;
    await this.#mutate(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === historyId,
      );
      if (entry === undefined || isTerminal(entry.status)) return;
      entry.status = "failed";
      entry.completedAt = this.#now();
      entry.error = bounded(error, 4_000);
      released = true;
    });
    if (released) {
      const active = [...generation.activeWakeups.values()].find(
        (candidate) => candidate.historyId === historyId,
      );
      if (active !== undefined)
        generation.activeWakeups.delete(active.clientUserMessageId);
    }
  }

  async #observeTitle(
    trigger: ZenXTrigger,
    projection?: string,
  ): Promise<void> {
    if (this.#titles === undefined) return;
    try {
      await this.#titles.observe(
        trigger.threadId,
        meaningfulWakeupTitleInput(trigger, projection),
      );
    } catch (error) {
      console.warn(`Could not stage trigger title: ${describeError(error)}`);
    }
  }

  #rescheduleTimers(generation: TriggerGeneration): void {
    if (!this.#isOperational(generation)) return;
    for (const timer of generation.timers.values())
      this.#cancelScheduled(timer);
    generation.timers.clear();
    for (const trigger of this.#snapshot.triggers) {
      if (trigger.active && trigger.timer !== undefined)
        this.#scheduleTimer(generation, trigger.id, trigger.timer.nextRunAt);
    }
  }

  #scheduleTimer(
    generation: TriggerGeneration,
    triggerId: string,
    scheduledAt: number,
  ): void {
    const delay = Math.max(
      0,
      Math.min(2_147_000_000, scheduledAt - this.#now()),
    );
    const timer = this.#schedule(() => {
      if (!this.#isOperational(generation)) return;
      generation.timers.delete(triggerId);
      if (this.#now() < scheduledAt) {
        this.#scheduleTimer(generation, triggerId, scheduledAt);
        return;
      }
      void this.#fire(generation, triggerId, {
        reason: `Timer reached ${new Date(scheduledAt).toISOString()}`,
        occurrenceKey: `timer:${scheduledAt}`,
        scheduledAt,
      }).catch((error: unknown) => {
        if (this.#isOperational(generation))
          console.warn(`Could not fire Timer: ${describeError(error)}`);
      });
    }, delay);
    generation.timers.set(triggerId, timer);
  }

  async #mutate<T>(
    generation: TriggerGeneration,
    operation: (snapshot: TriggerSnapshot) => Promise<T>,
    allowRetiring = false,
  ): Promise<T> {
    this.#assertMutationGeneration(generation, allowRetiring);
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertMutationGeneration(generation, allowRetiring);
      const snapshot = structuredClone(this.#snapshot);
      const result = await operation(snapshot);
      this.#assertMutationGeneration(generation, allowRetiring);
      await this.#store.write(snapshot);
      this.#assertMutationGeneration(generation, allowRetiring);
      this.#snapshot = snapshot;
      this.#notify();
      return result;
    } finally {
      release();
    }
  }

  #runningGeneration(): TriggerGeneration {
    const generation = this.#generation;
    if (generation === null || !this.#isOperational(generation))
      throw new Error("ZenX Trigger service is not running");
    return generation;
  }

  #isOperational(generation: TriggerGeneration): boolean {
    return (
      generation.active &&
      !generation.retiring &&
      this.#generation === generation
    );
  }

  #assertMutationGeneration(
    generation: TriggerGeneration,
    allowRetiring = false,
  ): void {
    if (
      !generation.active ||
      this.#generation !== generation ||
      (generation.retiring && !allowRetiring)
    )
      throw new StaleGenerationError();
  }

  #history(historyId: string): TriggerHistoryEntry {
    const entry = this.#snapshot.history.find(
      (candidate) => candidate.id === historyId,
    );
    if (entry === undefined) throw new StaleGenerationError();
    return entry;
  }

  #programOutcome(
    stage: "predicate" | "action",
    invocationId: string,
    status: TriggerProgramOutcome["status"],
    output: string | null,
    exitCode: number | null,
    error: string | null,
  ): TriggerProgramOutcome {
    return {
      stage,
      invocationId,
      status,
      output: bounded(output ?? "", 8_000) || null,
      exitCode,
      error: bounded(error ?? "", 2_048) || null,
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.snapshot());
  }
}

class StaleGenerationError extends Error {
  constructor() {
    super("ZenX Trigger service lifecycle changed");
  }
}

function newGeneration(): TriggerGeneration {
  return {
    id: randomUUID(),
    active: true,
    retiring: false,
    timers: new Map(),
    completedTurnItems: new Map(),
    pendingCompletedTurns: new Map(),
    activeWakeups: new Map(),
    programControllers: new Map(),
    disposeNotifications: undefined,
  };
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
    ...(programFromInput(input) === undefined
      ? {}
      : { program: programFromInput(input) }),
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

function programFromInput(
  input: CreateTriggerInput | UpdateTriggerInput,
): TriggerProgramConfig | undefined {
  const value = input as CreateTriggerInput & {
    program?: TriggerProgramConfig;
    predicate?: TriggerProgramSpec;
    action?: TriggerProgramSpec;
    match?: TriggerProgramConfig["match"];
  };
  const program = value.program ?? {
    ...(value.predicate === undefined ? {} : { predicate: value.predicate }),
    ...(value.action === undefined ? {} : { action: value.action }),
    ...(value.match === undefined ? {} : { match: value.match }),
  };
  if (Object.keys(program).length === 0) return undefined;
  validateProgram(program);
  return structuredClone(program);
}

function validateProgram(program: TriggerProgramConfig): void {
  if (
    program.predicate === undefined &&
    program.action === undefined &&
    program.match === undefined
  )
    throw new Error("Trigger program must define predicate, action, or match");
  for (const [stage, spec] of [
    ["predicate", program.predicate],
    ["action", program.action],
  ] as const) {
    if (spec === undefined) continue;
    if (required(spec.command, `${stage} command`).length > 4_096)
      throw new Error(`${stage} command is too long`);
    if ((spec.args?.length ?? 0) > 64)
      throw new Error(`${stage} has too many arguments`);
    if (spec.args?.some((arg) => arg.length > 4_096))
      throw new Error(`${stage} argument is too long`);
    if (
      spec.cwd !== undefined &&
      required(spec.cwd, `${stage} cwd`).length > 4_096
    )
      throw new Error(`${stage} cwd is too long`);
    if (
      spec.timeoutMs !== undefined &&
      (!Number.isFinite(spec.timeoutMs) ||
        spec.timeoutMs <= 0 ||
        spec.timeoutMs > 120_000)
    )
      throw new Error(`${stage} timeoutMs must be between 1 and 120000`);
    if (
      spec.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(spec.maxOutputBytes) ||
        spec.maxOutputBytes < 256 ||
        spec.maxOutputBytes > 1024 * 1024)
    )
      throw new Error(
        `${stage} maxOutputBytes must be between 256 and 1048576`,
      );
    if (
      spec.env !== undefined &&
      Object.entries(spec.env).some(
        ([key, value]) =>
          key.length === 0 || key.length > 256 || value.length > 4_096,
      )
    )
      throw new Error(`${stage} env is invalid`);
  }
  if (program.match !== undefined) {
    if (
      program.match.field !== "completedItemText" ||
      required(program.match.regex, "match regex").length > 4_096
    )
      throw new Error("Trigger match is invalid");
    try {
      new RegExp(program.match.regex, program.match.flags ?? "u");
    } catch (error) {
      throw new Error(
        `Trigger match regex is invalid: ${describeError(error)}`,
      );
    }
  }
}

function programInput(active: ActiveWakeup, wakeup: WakeupEvent): unknown {
  return {
    triggerId: active.trigger.id,
    historyId: active.historyId,
    generationId: active.generationId,
    clientUserMessageId: active.clientUserMessageId,
    occurrenceKey: wakeup.occurrenceKey,
    reason: bounded(wakeup.reason, 4_000),
    source: {
      threadId: wakeup.sourceThreadId ?? null,
      turnId: wakeup.sourceTurnId ?? null,
      roomId: wakeup.sourceRoomId ?? null,
      roomMessageId: wakeup.sourceRoomMessageId ?? null,
    },
    completedItemText: bounded(wakeup.eventText ?? "", 8_000),
    projection: bounded(wakeup.projection ?? "", 8_000),
  };
}

function stableProgramInvocationId(
  clientUserMessageId: string,
  stage: "predicate" | "action",
): string {
  const digest = createHash("sha256")
    .update(`${clientUserMessageId}:${stage}`)
    .digest("hex")
    .slice(0, 32);
  return `zenx-program:${stage}:${digest}`;
}

function programStageForInvocation(
  invocationId: string,
): "predicate" | "action" {
  return invocationId.includes(":predicate:") ? "predicate" : "action";
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
  if (typeof value !== "string" || value.trim().length === 0)
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

function mentionMatches(text: string, name: string): boolean {
  return new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$|[,.!?])`, "iu").test(
    text,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stableWakeupId(triggerId: string, occurrenceKey: string): string {
  const occurrence = createHash("sha256")
    .update(occurrenceKey)
    .digest("hex")
    .slice(0, 24);
  return `zenx-wakeup:${triggerId}:${occurrence}`;
}

function transientTurnKey(threadId: string, turnId: string): string {
  return `${String(threadId.length)}:${threadId}:${turnId}`;
}

function clearTransientTurn(
  generation: TriggerGeneration,
  threadId: string,
  turnId: string,
): void {
  const key = transientTurnKey(threadId, turnId);
  generation.completedTurnItems.delete(key);
  generation.pendingCompletedTurns.delete(key);
}

function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  onEvict: (key: K) => void,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRANSIENT_TURNS) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
    onEvict(oldest);
  }
}

function isTerminal(status: TriggerHistoryEntry["status"]): boolean {
  return status === "completed" || status === "failed";
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
      : [
          "",
          "Bounded source context (read-only projection):",
          bounded(projection, 6_000),
        ]),
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
        `$ ${bounded(item.command, 500)}\nStatus: ${item.status}${item.exitCode === null ? "" : ` (exit ${item.exitCode})`}\n${bounded(item.aggregatedOutput ?? "No captured output", 1_000)}`,
    );
  return bounded(
    [
      `Source Thread: ${threadId}`,
      `Source Turn: ${turn.id}`,
      `Status: ${turn.status}`,
      userInputs.length === 0
        ? null
        : `User input:\n${userInputs.join("\n\n")}`,
      commands.length === 0
        ? null
        : `Command/result summary:\n${commands.join("\n\n")}`,
      conclusion?.type === "agentMessage"
        ? `Agent conclusion:\n${bounded(conclusion.text, 1_800)}`
        : "Agent conclusion:\nNo final Agent message was emitted.",
    ]
      .filter((section): section is string => section !== null)
      .join("\n\n"),
    6_000,
  );
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
  for (const item of completedItems)
    if (!included.has(item.id)) merged.push(item);
  return merged;
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 24))}\n…[truncated by ZenX]`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

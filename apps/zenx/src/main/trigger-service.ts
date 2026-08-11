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

const MAX_TRANSIENT_TURNS = 64;
const MAX_COMPLETED_ITEMS_PER_TURN = 64;

interface InFlightWakeup {
  historyId: string;
  threadId: string;
  clientUserMessageId: string;
}

interface PendingCompletion {
  event: ServerNotificationParams["turn/completed"];
  clientUserMessageId: string | null;
  rejected: boolean;
  claimed: boolean;
}

interface CompletedItemBuffer {
  threadId: string;
  items: ThreadItem[];
}

class ZenXTriggerLifecycleGeneration {
  readonly timers = new Map<string, unknown>();
  readonly completedTurnItems = new Map<string, CompletedItemBuffer>();
  readonly pendingCompletedTurns = new Map<string, PendingCompletion>();
  readonly inFlightWakeups = new Map<string, InFlightWakeup>();
  #active = true;
  #disposeNotifications: (() => void) | undefined;

  get active(): boolean {
    return this.#active;
  }

  attachNotifications(dispose: () => void): void {
    if (!this.#active) {
      dispose();
      return;
    }
    this.#disposeNotifications?.();
    this.#disposeNotifications = dispose;
  }

  retire(cancelScheduled: (handle: unknown) => void): void {
    if (!this.#active) return;
    this.#active = false;
    this.#disposeNotifications?.();
    this.#disposeNotifications = undefined;
    for (const timer of this.timers.values()) cancelScheduled(timer);
    this.timers.clear();
    this.clearTransientState();
  }

  clearTransientState(): void {
    this.completedTurnItems.clear();
    this.pendingCompletedTurns.clear();
    this.inFlightWakeups.clear();
  }

  clearTransientTurn(threadId: string, turnId: string): void {
    const key = transientTurnKey(threadId, turnId);
    this.completedTurnItems.delete(key);
    this.pendingCompletedTurns.delete(key);
  }
}

class StaleTriggerGenerationError extends Error {
  constructor() {
    super("ZenX Trigger service lifecycle changed");
  }
}

export class ZenXTriggerService {
  readonly #manager: ZenXTriggerAppServerPort;
  readonly #store: ZenXTriggerStore;
  readonly #titles: ZenXTriggerTitlePort | undefined;
  readonly #listeners = new Set<(snapshot: TriggerSnapshot) => void>();
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  #snapshot: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  #mutation: Promise<void> = Promise.resolve();
  #activeGeneration: ZenXTriggerLifecycleGeneration | null = null;

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
    const generation = this.#beginGeneration();
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertGeneration(generation);
      const snapshot = await this.#store.read();
      this.#assertGeneration(generation);
      for (const entry of snapshot.history) {
        if (entry.status === "starting" || entry.status === "running") {
          entry.status = "failed";
          entry.completedAt = this.#now();
          entry.error =
            "ZenX stopped before this wakeup reached a visible terminal result; it was not retried.";
        }
      }
      this.#assertGeneration(generation);
      await this.#store.write(snapshot);
      this.#assertGeneration(generation);
      this.#snapshot = snapshot;
      this.#notifyListeners();
      this.#rescheduleTimers(generation);
      const listener = (
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ): void => {
        if (!this.#isActive(generation)) return;
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
            if (this.#isActive(generation)) {
              console.warn(
                `Could not process Trigger completion: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          });
        }
      };
      generation.attachNotifications(this.#manager.onNotification(listener));
    } catch (error) {
      this.#retireGeneration(generation);
      if (!(error instanceof StaleTriggerGenerationError)) throw error;
    } finally {
      release();
    }
  }

  async stop(): Promise<void> {
    const drain = this.#mutation;
    const generation = this.#activeGeneration;
    this.#activeGeneration = null;
    generation?.retire(this.#cancelScheduled);
    await drain;
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
      snapshot.triggers.push(trigger);
      return trigger;
    });
    this.#rescheduleTimers(generation);
    return structuredClone(trigger);
  }

  async cancel(triggerId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const trigger = snapshot.triggers.find((item) => item.id === triggerId);
      if (trigger === undefined) throw new Error("Trigger was not found");
      trigger.active = false;
      const timer = generation.timers.get(trigger.id);
      if (timer !== undefined) this.#cancelScheduled(timer);
      generation.timers.delete(trigger.id);
    });
  }

  async signal(name: string, detail: string): Promise<void> {
    const generation = this.#runningGeneration();
    const signalName = required(name, "signal name");
    const signalDetail = detail.trim();
    const matches = this.#snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.kind === "signal" &&
        trigger.signal?.name === signalName,
    );
    for (const trigger of matches)
      await this.#fire(generation, trigger.id, {
        reason: `External signal ${signalName}: ${signalDetail}`,
        occurrenceKey: `signal:${randomUUID()}`,
        projection: `Signal name: ${signalName}\nSignal detail: ${bounded(signalDetail, 4_000)}`,
      });
  }

  async createRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    const generation = this.#runningGeneration();
    const room = await this.#mutate(generation, async (snapshot) => {
      const members = validateMembers(input.members);
      const room: ZenXRoom = {
        id: randomUUID(),
        name: required(input.name, "room name"),
        members,
        messages: [],
        createdAt: this.#now(),
      };
      snapshot.rooms.push(room);
      return room;
    });
    return structuredClone(room);
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
    const generation = this.#runningGeneration();
    const { posted, room } = await this.#mutate(
      generation,
      async (snapshot) => {
        const room = snapshot.rooms.find((entry) => entry.id === roomId);
        if (room === undefined) throw new Error("Room was not found");
        const posted = message(
          room.id,
          required(author, "author"),
          required(text, "message"),
          "human",
          null,
          null,
          this.#now(),
        );
        room.messages.push(posted);
        return { posted, room: structuredClone(room) };
      },
    );
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
        await this.#fire(generation, trigger.id, {
          reason: `Room #${room.name} mention from ${posted.author}: ${posted.text}`,
          occurrenceKey: `room:${room.id}:${posted.id}`,
          sourceRoomId: room.id,
          sourceRoomMessageId: posted.id,
          projection: projectRoomContext(room),
        });
    }
  }

  async #handleTurnCompleted(
    generation: ZenXTriggerLifecycleGeneration,
    event: ServerNotificationParams["turn/completed"],
  ): Promise<void> {
    if (!this.#isActive(generation)) return;
    const key = transientTurnKey(event.threadId, event.turn.id);
    const buffered = generation.completedTurnItems.get(key);
    const completedItems = mergeCompletedItems(
      event.turn.items,
      buffered?.threadId === event.threadId ? buffered.items : [],
    );
    const running = this.#snapshot.history.find(
      (item) =>
        item.turnId === event.turn.id &&
        item.threadId === event.threadId &&
        item.status === "running",
    );
    if (running !== undefined) {
      await this.#mutateMaybe(generation, async (snapshot) => {
        const current = snapshot.history.find(
          (entry) =>
            entry.id === running.id &&
            entry.turnId === event.turn.id &&
            entry.threadId === event.threadId &&
            entry.status === "running",
        );
        if (current === undefined) return undefined;
        this.#applyCompletion(snapshot, running.id, event, completedItems);
        return true;
      });
      generation.clearTransientTurn(event.threadId, event.turn.id);
    } else {
      this.#bufferEarlyCompletion(generation, event, completedItems);
    }
    if (!this.#isActive(generation)) return;
    const watchers = this.#snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.kind === "thread" &&
        trigger.watch?.threadId === event.threadId,
    );
    for (const trigger of watchers)
      await this.#fire(generation, trigger.id, {
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
    generation: ZenXTriggerLifecycleGeneration,
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
    let activeWakeup: InFlightWakeup | undefined;
    try {
      const committed = await this.#mutateMaybe(
        generation,
        async (snapshot) => {
          const trigger = snapshot.triggers.find(
            (item) => item.id === triggerId && item.active,
          );
          if (trigger === undefined) return undefined;
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
          const history: TriggerHistoryEntry = {
            id: randomUUID(),
            triggerId: trigger.id,
            threadId: trigger.threadId,
            kind: trigger.kind,
            reason: wakeup.reason,
            prompt: trigger.prompt,
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
            replyRoomId: trigger.room?.roomId ?? null,
            replyAuthor: trigger.room?.mention ?? null,
          };
          snapshot.history.unshift(history);
          if (trigger.timer !== undefined) {
            if (trigger.timer.intervalMinutes === null) trigger.active = false;
            else
              trigger.timer.nextRunAt =
                Math.max(this.#now(), wakeup.scheduledAt ?? this.#now()) +
                trigger.timer.intervalMinutes * 60_000;
          }
          return {
            trigger: structuredClone(trigger),
            historyId: history.id,
            clientUserMessageId,
          };
        },
      );
      if (committed === undefined) return;
      const { trigger, historyId, clientUserMessageId } = committed;
      this.#rescheduleTimers(generation);
      if (!this.#isActive(generation)) return;
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
      if (!this.#isActive(generation)) return;
      activeWakeup = {
        historyId,
        threadId: trigger.threadId,
        clientUserMessageId,
      };
      generation.inFlightWakeups.set(clientUserMessageId, activeWakeup);
      const result = await this.#manager.request("turn/start", {
        threadId: trigger.threadId,
        clientUserMessageId,
        input: [
          {
            type: "text",
            text: wakeupInput(
              trigger,
              this.#history(historyId),
              wakeup.projection,
            ),
          },
        ],
      });
      if (!this.#isActive(generation)) return;
      await this.#mutate(generation, async (snapshot) => {
        const history = snapshot.history.find(
          (entry) => entry.id === historyId,
        );
        if (history === undefined || history.status !== "starting") return;
        history.status = "running";
        history.turnId = result.turn.id;
      });
      await this.#consumePendingCompletion(
        generation,
        historyId,
        trigger.threadId,
        clientUserMessageId,
        result.turn.id,
      );
    } catch (error) {
      if (error instanceof StaleTriggerGenerationError) return;
      if (activeWakeup === undefined) throw error;
      if (this.#isActive(generation)) {
        const failedWakeup = activeWakeup;
        await this.#mutate(generation, async (snapshot) => {
          const history = snapshot.history.find(
            (entry) => entry.id === failedWakeup.historyId,
          );
          if (history === undefined || history.status !== "starting") return;
          history.status = "failed";
          history.completedAt = this.#now();
          history.error =
            error instanceof Error ? error.message : String(error);
        });
      }
    } finally {
      if (
        activeWakeup !== undefined &&
        generation.inFlightWakeups.get(activeWakeup.clientUserMessageId) ===
          activeWakeup
      ) {
        generation.inFlightWakeups.delete(activeWakeup.clientUserMessageId);
      }
      this.#evictUnmatchablePending(generation);
    }
  }

  #rescheduleTimers(generation: ZenXTriggerLifecycleGeneration): void {
    if (!this.#isActive(generation)) return;
    this.#cancelTimers(generation);
    for (const trigger of this.#snapshot.triggers) {
      if (!trigger.active || trigger.timer === undefined) continue;
      this.#scheduleTimer(generation, trigger.id, trigger.timer.nextRunAt);
    }
  }

  #scheduleTimer(
    generation: ZenXTriggerLifecycleGeneration,
    triggerId: string,
    scheduledAt: number,
  ): void {
    const delay = Math.max(
      0,
      Math.min(2_147_000_000, scheduledAt - this.#now()),
    );
    const timer = this.#schedule(() => {
      if (!this.#isActive(generation)) return;
      generation.timers.delete(triggerId);
      if (this.#now() < scheduledAt) {
        this.#scheduleTimer(generation, triggerId, scheduledAt);
        return;
      }
      void this.#fire(generation, triggerId, {
        reason: `Timer reached ${new Date(scheduledAt).toISOString()}`,
        occurrenceKey: `timer:${scheduledAt}`,
        scheduledAt,
      });
    }, delay);
    generation.timers.set(triggerId, timer);
  }

  async #mutate<T>(
    generation: ZenXTriggerLifecycleGeneration,
    operation: (snapshot: TriggerSnapshot) => Promise<T>,
  ): Promise<T> {
    this.#assertGeneration(generation);
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertGeneration(generation);
      const snapshot = structuredClone(this.#snapshot);
      const result = await operation(snapshot);
      this.#assertGeneration(generation);
      await this.#store.write(snapshot);
      this.#assertGeneration(generation);
      this.#snapshot = snapshot;
      this.#notifyListeners();
      return result;
    } finally {
      release();
    }
  }

  async #mutateMaybe<T>(
    generation: ZenXTriggerLifecycleGeneration,
    operation: (snapshot: TriggerSnapshot) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    this.#assertGeneration(generation);
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertGeneration(generation);
      const snapshot = structuredClone(this.#snapshot);
      const result = await operation(snapshot);
      if (result === undefined) return undefined;
      this.#assertGeneration(generation);
      await this.#store.write(snapshot);
      this.#assertGeneration(generation);
      this.#snapshot = snapshot;
      this.#notifyListeners();
      return result;
    } finally {
      release();
    }
  }

  #notifyListeners(): void {
    for (const listener of this.#listeners) listener(this.snapshot());
  }

  #beginGeneration(): ZenXTriggerLifecycleGeneration {
    const previous = this.#activeGeneration;
    const generation = new ZenXTriggerLifecycleGeneration();
    this.#activeGeneration = generation;
    previous?.retire(this.#cancelScheduled);
    return generation;
  }

  #retireGeneration(generation: ZenXTriggerLifecycleGeneration): void {
    if (this.#activeGeneration === generation) this.#activeGeneration = null;
    generation.retire(this.#cancelScheduled);
  }

  #runningGeneration(): ZenXTriggerLifecycleGeneration {
    if (this.#activeGeneration === null)
      throw new Error("ZenX Trigger service is not running");
    return this.#activeGeneration;
  }

  #isActive(generation: ZenXTriggerLifecycleGeneration): boolean {
    return generation.active && this.#activeGeneration === generation;
  }

  #assertGeneration(generation: ZenXTriggerLifecycleGeneration): void {
    if (!this.#isActive(generation)) throw new StaleTriggerGenerationError();
  }

  #cancelTimers(generation: ZenXTriggerLifecycleGeneration): void {
    for (const timer of generation.timers.values())
      this.#cancelScheduled(timer);
    generation.timers.clear();
  }

  #handleItemCompleted(
    generation: ZenXTriggerLifecycleGeneration,
    event: ServerNotificationParams["item/completed"],
  ): void {
    const key = transientTurnKey(event.threadId, event.turnId);
    const current = generation.completedTurnItems.get(key);
    if (!this.#isPotentialWakeupTurn(generation, event.threadId, event.turnId))
      return;
    const items = (current?.items ?? []).filter(
      (item) => item.id !== event.item.id,
    );
    items.push(event.item);
    this.#setBounded(
      generation.completedTurnItems,
      key,
      {
        threadId: event.threadId,
        items: items.slice(-MAX_COMPLETED_ITEMS_PER_TURN),
      },
      (evictedKey) => generation.pendingCompletedTurns.delete(evictedKey),
    );
  }

  #isPotentialWakeupTurn(
    generation: ZenXTriggerLifecycleGeneration,
    threadId: string,
    turnId: string,
  ): boolean {
    const key = transientTurnKey(threadId, turnId);
    return (
      this.#snapshot.history.some(
        (entry) =>
          entry.turnId === turnId &&
          entry.threadId === threadId &&
          entry.status === "running",
      ) ||
      generation.pendingCompletedTurns.has(key) ||
      generation.completedTurnItems.has(key) ||
      this.#snapshot.triggers.some(
        (trigger) =>
          trigger.active &&
          trigger.kind === "thread" &&
          trigger.watch?.threadId === threadId,
      ) ||
      [...generation.inFlightWakeups.values()].some(
        (entry) => entry.threadId === threadId,
      )
    );
  }

  #bufferEarlyCompletion(
    generation: ZenXTriggerLifecycleGeneration,
    event: ServerNotificationParams["turn/completed"],
    completedItems: readonly ThreadItem[],
  ): void {
    const key = transientTurnKey(event.threadId, event.turn.id);
    const existing = generation.pendingCompletedTurns.get(key);
    const sameThreadWakeups = [...generation.inFlightWakeups.values()].filter(
      (entry) => entry.threadId === event.threadId,
    );
    if (sameThreadWakeups.length === 0) {
      generation.clearTransientTurn(event.threadId, event.turn.id);
      return;
    }
    const clientIds = completedItems
      .filter((item) => item.type === "userMessage")
      .map((item) => item.clientId)
      .filter((clientId): clientId is string => clientId !== null);
    const soleClientId = clientIds.length === 1 ? clientIds[0]! : null;
    const soleWakeup =
      soleClientId === null
        ? undefined
        : generation.inFlightWakeups.get(soleClientId);
    const clientUserMessageId =
      soleWakeup?.threadId === event.threadId ? soleClientId : null;
    if (existing?.claimed === true) return;
    if (existing?.rejected === true) return;
    if (
      clientIds.length === 0 &&
      existing !== undefined &&
      existing.clientUserMessageId !== null
    ) {
      return;
    }
    if (clientIds.length !== 1 || clientUserMessageId === null) {
      generation.completedTurnItems.delete(key);
      this.#setBounded(
        generation.pendingCompletedTurns,
        key,
        {
          event,
          clientUserMessageId: null,
          rejected: true,
          claimed: false,
        },
        (evictedKey) => generation.completedTurnItems.delete(evictedKey),
      );
      return;
    }
    if (existing !== undefined) {
      if (existing.clientUserMessageId === clientUserMessageId) {
        return;
      }
      generation.completedTurnItems.delete(key);
      this.#setBounded(
        generation.pendingCompletedTurns,
        key,
        {
          event,
          clientUserMessageId: null,
          rejected: true,
          claimed: false,
        },
        (evictedKey) => generation.completedTurnItems.delete(evictedKey),
      );
      return;
    }
    this.#setBounded(
      generation.pendingCompletedTurns,
      key,
      { event, clientUserMessageId, rejected: false, claimed: false },
      (evictedKey) => generation.completedTurnItems.delete(evictedKey),
    );
  }

  async #consumePendingCompletion(
    generation: ZenXTriggerLifecycleGeneration,
    historyId: string,
    threadId: string,
    clientUserMessageId: string,
    turnId: string,
  ): Promise<void> {
    const key = transientTurnKey(threadId, turnId);
    const consumed = await this.#mutateMaybe(generation, async (snapshot) => {
      const history = snapshot.history.find(
        (entry) =>
          entry.id === historyId &&
          entry.threadId === threadId &&
          entry.turnId === turnId &&
          entry.status === "running",
      );
      if (history === undefined) return undefined;
      const pending = generation.pendingCompletedTurns.get(key);
      if (
        pending === undefined ||
        pending.claimed ||
        pending.rejected ||
        pending.event.threadId !== threadId ||
        pending.clientUserMessageId !== clientUserMessageId
      )
        return undefined;
      const buffer = generation.completedTurnItems.get(key);
      if (buffer !== undefined && buffer.threadId !== threadId)
        return undefined;
      pending.claimed = true;
      this.#applyCompletion(
        snapshot,
        historyId,
        pending.event,
        mergeCompletedItems(pending.event.turn.items, buffer?.items ?? []),
      );
      return { pending, buffer };
    });
    if (consumed === undefined) return;
    if (generation.pendingCompletedTurns.get(key) === consumed.pending)
      generation.pendingCompletedTurns.delete(key);
    if (
      consumed.buffer !== undefined &&
      generation.completedTurnItems.get(key) === consumed.buffer
    )
      generation.completedTurnItems.delete(key);
  }

  #applyCompletion(
    snapshot: TriggerSnapshot,
    historyId: string,
    event: ServerNotificationParams["turn/completed"],
    completedItems: readonly ThreadItem[],
  ): void {
    const entry = snapshot.history.find((item) => item.id === historyId);
    if (
      entry === undefined ||
      (entry.status !== "running" && entry.status !== "starting")
    )
      return;
    entry.status = event.turn.status === "completed" ? "completed" : "failed";
    entry.completedAt = this.#now();
    entry.error = event.turn.error?.message ?? null;
    if (entry.replyRoomId === null || entry.replyAuthor === null) return;
    const room = snapshot.rooms.find((item) => item.id === entry.replyRoomId);
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
          answer.text,
          "agent",
          entry.threadId,
          event.turn.id,
          this.#now(),
        ),
      );
    }
  }

  #history(historyId: string): TriggerHistoryEntry {
    const history = this.#snapshot.history.find(
      (entry) => entry.id === historyId,
    );
    if (history === undefined) throw new StaleTriggerGenerationError();
    return history;
  }

  #evictUnmatchablePending(generation: ZenXTriggerLifecycleGeneration): void {
    const activeClientIds = new Set(
      [...generation.inFlightWakeups.values()].map(
        (entry) => entry.clientUserMessageId,
      ),
    );
    const activeThreads = new Set(
      [...generation.inFlightWakeups.values()].map((entry) => entry.threadId),
    );
    for (const pending of generation.pendingCompletedTurns.values()) {
      if (
        pending.clientUserMessageId === null
          ? !activeThreads.has(pending.event.threadId)
          : !activeClientIds.has(pending.clientUserMessageId)
      ) {
        generation.clearTransientTurn(
          pending.event.threadId,
          pending.event.turn.id,
        );
      }
    }
  }

  #setBounded<K, V>(
    map: Map<K, V>,
    key: K,
    value: V,
    onEvict: (key: K) => void,
  ): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TRANSIENT_TURNS) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
      onEvict(oldest);
    }
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

function transientTurnKey(threadId: string, turnId: string): string {
  return `${String(threadId.length)}:${threadId}${turnId}`;
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

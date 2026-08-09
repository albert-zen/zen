import { randomUUID } from "node:crypto";

import type { ServerNotificationParams } from "../protocol-client/index.js";
import type { AppServerManager } from "./app-server-manager.js";
import { ZenXTriggerStore } from "./trigger-store.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMessage,
  TriggerHistoryEntry,
  TriggerSnapshot,
  ZenXRoom,
  ZenXTrigger,
} from "./trigger-types.js";

export class ZenXTriggerService {
  readonly #manager: AppServerManager;
  readonly #store: ZenXTriggerStore;
  readonly #listeners = new Set<(snapshot: TriggerSnapshot) => void>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #completedAgentMessages = new Map<string, string>();
  #snapshot: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  #mutation: Promise<void> = Promise.resolve();

  constructor(manager: AppServerManager, store: ZenXTriggerStore) {
    this.#manager = manager;
    this.#store = store;
  }

  async start(): Promise<void> {
    this.#snapshot = await this.#store.read();
    for (const entry of this.#snapshot.history) {
      if (entry.status === "starting" || entry.status === "running") {
        entry.status = "failed";
        entry.completedAt = Date.now();
        entry.error =
          "ZenX stopped before this wakeup reached a visible terminal result; it was not retried.";
      }
    }
    await this.#persist();
    this.#rescheduleTimers();
    this.#manager.onNotification((method, params) => {
      if (method === "item/completed") {
        const event = params as ServerNotificationParams["item/completed"];
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
    for (const timer of this.#timers.values()) clearTimeout(timer);
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
        createdAt: Date.now(),
        active: true,
      };
      const trigger: ZenXTrigger =
        input.kind === "timer"
          ? {
              ...common,
              timer: {
                nextRunAt: validFuture(input.runAt),
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
      if (timer !== undefined) clearTimeout(timer);
      this.#timers.delete(trigger.id);
    });
  }

  async signal(name: string, detail: string): Promise<void> {
    const matches = this.#snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.kind === "signal" &&
        trigger.signal?.name === name,
    );
    for (const trigger of matches)
      await this.#fire(trigger.id, `External signal ${name}: ${detail}`);
  }

  async createRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    return await this.#mutate(async () => {
      const room: ZenXRoom = {
        id: randomUUID(),
        name: required(input.name, "room name"),
        members: input.members.map((member) => ({
          name: required(member.name, "member name"),
          threadId: required(member.threadId, "member thread"),
        })),
        messages: [],
        createdAt: Date.now(),
      };
      this.#snapshot.rooms.push(room);
      return room;
    });
  }

  async postRoomMessage(
    roomId: string,
    author: string,
    text: string,
  ): Promise<void> {
    const room = this.#snapshot.rooms.find((entry) => entry.id === roomId);
    if (room === undefined) throw new Error("Room was not found");
    await this.#mutate(async () => {
      room.messages.push(
        message(
          room.id,
          required(author, "author"),
          required(text, "message"),
          "human",
          null,
          null,
        ),
      );
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
        await this.#fire(
          trigger.id,
          `Room #${room.name} mention from ${author}: ${text}`,
        );
    }
  }

  async #handleTurnCompleted(
    event: ServerNotificationParams["turn/completed"],
  ): Promise<void> {
    await this.#mutate(async () => {
      const entry = this.#snapshot.history.find(
        (item) => item.turnId === event.turn.id && item.status === "running",
      );
      if (entry !== undefined) {
        entry.status =
          event.turn.status === "completed" ? "completed" : "failed";
        entry.completedAt = Date.now();
        entry.error = event.turn.error?.message ?? null;
        const trigger = this.#snapshot.triggers.find(
          (item) => item.id === entry.triggerId,
        );
        if (trigger?.kind === "roomMention" && trigger.room !== undefined) {
          const room = this.#snapshot.rooms.find(
            (item) => item.id === trigger.room?.roomId,
          );
          const projectedAnswer = [...event.turn.items]
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
                trigger.room.mention,
                answer,
                "agent",
                entry.threadId,
                event.turn.id,
              ),
            );
          }
        }
      }
    });
    this.#completedAgentMessages.delete(event.turn.id);
    const watchers = this.#snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.kind === "thread" &&
        trigger.watch?.threadId === event.threadId,
    );
    for (const trigger of watchers)
      await this.#fire(
        trigger.id,
        `Thread ${event.threadId} emitted turn_completed for ${event.turn.id}`,
      );
  }

  async #fire(
    triggerId: string,
    reason: string,
    scheduledAt?: number,
  ): Promise<void> {
    const trigger = this.#snapshot.triggers.find(
      (item) => item.id === triggerId && item.active,
    );
    if (trigger === undefined) return;
    const occurrence = scheduledAt ?? Date.now();
    const clientUserMessageId = `zenx-wakeup:${trigger.id}:${occurrence}`;
    if (
      this.#snapshot.history.some(
        (entry) => entry.clientUserMessageId === clientUserMessageId,
      )
    )
      return;
    const history: TriggerHistoryEntry = {
      id: randomUUID(),
      triggerId: trigger.id,
      threadId: trigger.threadId,
      kind: trigger.kind,
      reason,
      prompt: trigger.prompt,
      clientUserMessageId,
      startedAt: Date.now(),
      completedAt: null,
      status: "starting",
      turnId: null,
      error: null,
    };
    await this.#mutate(async () => {
      this.#snapshot.history.unshift(history);
      if (trigger.timer !== undefined) {
        if (trigger.timer.intervalMinutes === null) trigger.active = false;
        else
          trigger.timer.nextRunAt =
            Math.max(Date.now(), occurrence) +
            trigger.timer.intervalMinutes * 60_000;
      }
    });
    this.#rescheduleTimers();
    try {
      const result = await this.#manager.request("turn/start", {
        threadId: trigger.threadId,
        clientUserMessageId,
        input: [
          {
            type: "text",
            text: `[ZenX trigger wakeup]\nReason: ${reason}\nRegistered trigger: ${trigger.label}\n\nInjected prompt:\n${trigger.prompt}`,
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
        history.completedAt = Date.now();
        history.error = error instanceof Error ? error.message : String(error);
      });
    }
  }

  #rescheduleTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const trigger of this.#snapshot.triggers) {
      if (!trigger.active || trigger.timer === undefined) continue;
      const scheduledAt = trigger.timer.nextRunAt;
      const delay = Math.max(
        0,
        Math.min(2_147_000_000, scheduledAt - Date.now()),
      );
      const timer = setTimeout(() => {
        this.#timers.delete(trigger.id);
        void this.#fire(
          trigger.id,
          `Timer reached ${new Date(scheduledAt).toISOString()}`,
          scheduledAt,
        );
      }, delay);
      this.#timers.set(trigger.id, timer);
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const result = await operation();
      await this.#persist();
      return result;
    } finally {
      release();
    }
  }

  async #persist(): Promise<void> {
    await this.#store.write(this.#snapshot);
    for (const listener of this.#listeners) listener(this.snapshot());
  }
}

function message(
  roomId: string,
  author: string,
  text: string,
  kind: RoomMessage["kind"],
  originThreadId: string | null,
  originTurnId: string | null,
): RoomMessage {
  return {
    id: randomUUID(),
    roomId,
    author,
    text,
    createdAt: Date.now(),
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
function validFuture(value: number): number {
  if (!Number.isFinite(value) || value <= Date.now())
    throw new Error("Timer must be scheduled in the future");
  return value;
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

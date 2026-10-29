import {
  ALWAYS_ON_ASSISTANT_PROMPT,
  PAW_HEARTBEAT_INTERVAL_MINUTES,
  pawHeartbeatPrompt,
} from "./assistant-preset.js";
import { canonicalAssistantWorkspace } from "./trigger-store.js";
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
import {
  MAX_ERROR_BYTES,
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
  MAX_PROGRAM_TIMEOUT_MS,
  MAX_REASON_BYTES,
  MAX_ROOM_COUNT,
  MAX_ROOM_MEMBERS,
  MAX_ROOM_MESSAGES,
  MAX_ROOM_OPERATIONS,
  MAX_ROOM_NAME_BYTES,
  MAX_TRIGGER_COUNT,
  MAX_TRIGGER_LABEL_BYTES,
  MAX_TRIGGER_PROMPT_BYTES,
  retainHistory,
  utf8Bytes,
  withinBytes,
} from "./trigger-limits.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  RoomMessage,
  RoomSendOperation,
  RoomDeliveryView,
  TriggerHistoryEntry,
  TriggerProgramConfig,
  TriggerProgramOutcome,
  TriggerProgramSpec,
  TriggerSnapshot,
  TriggerSidebarSnapshot,
  UpdateTriggerInput,
  ZenXRoom,
  ZenXTrigger,
  AssistantWorkspace,
  UpdateAssistantWorkspaceInput,
  WakeupDeliveryMode,
} from "./trigger-types.js";

export interface ZenXTriggerAppServerPort {
  onReconnect?(listener: () => void): () => void;
  readThread?(threadId: string): Promise<ClientRequestResults["thread/read"]>;
  resolveRemoteThread?(
    device: string,
    workspace: string | undefined,
    target: string,
  ): Promise<{ threadId: string; workspace?: string }>;
  readRemoteThread?(
    device: string,
    workspace: string | undefined,
    threadId: string,
    turnId?: string,
  ): Promise<{
    threadId: string;
    turns: Array<{ id: string; status: Turn["status"]; preview: string }>;
  }>;
  subscribeRemoteThread?(
    device: string,
    workspace: string | undefined,
    threadId: string,
    options: {
      includeCurrentTerminal: boolean;
      onTurn(value: {
        threadId: string;
        turnId: string;
        status: Turn["status"];
      }): void;
      onError(error: Error): void;
      onReady?(): void;
    },
    signal: AbortSignal,
  ): Promise<() => void>;
  request(
    method: "turn/start" | "zen/turn/wake" | "zen/thread/resume",
    params:
      | ClientRequestParams["turn/start"]
      | ClientRequestParams["zen/turn/wake"]
      | ClientRequestParams["zen/thread/resume"],
  ): Promise<
    | ClientRequestResults["turn/start"]
    | ClientRequestResults["zen/turn/wake"]
    | ClientRequestResults["zen/thread/resume"]
  >;
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

export interface ZenXTriggerStorePort {
  read(): Promise<TriggerSnapshot>;
  write(snapshot: TriggerSnapshot): Promise<void>;
}

const MAX_WAKEUPS = 64;
const MAX_TRANSIENT_TURNS = 64;
const MAX_ITEMS_PER_TURN = 64;
const MAX_RECOVERY_EVENTS = 256;
const MAX_RECOVERY_BYTES = 1_048_576;
const MAX_PROGRAM_OUTCOMES = 4;

interface WakeupEvent {
  /** Room-owned choice captured when its message and wakeup commit together. */
  roomDeliveryMode?: WakeupDeliveryMode;
  /** Exact addressed UI message fence, not inferred from mentions. */
  roomRecipientThreadId?: string;
  bootstrapText?: string;
  reason: string;
  occurrenceKey: string;
  projection?: string;
  eventText?: string;
  sourceThreadId?: string;
  sourceDevice?: string;
  sourceWorkspace?: string;
  sourceDefinitionRevision?: number;
  sourceSubscriptionId?: string;
  sourceTurnId?: string;
  sourceRoomId?: string;
  sourceRoomMessageId?: string;
  sourceRoomMessageText?: string;
  scheduledAt?: number;
}

interface ActiveWakeup {
  bootstrap?: true;
  historyId: string;
  threadId: string;
  clientUserMessageId: string;
  trigger: ZenXTrigger;
  generationId: string;
}

interface CommittedWakeup {
  historyId: string;
  clientUserMessageId: string;
  trigger: ZenXTrigger;
  wakeup: WakeupEvent;
}

type WakeupCommitResult = CommittedWakeup | { rejected: true } | undefined;

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
  storeUnavailable: boolean;
  wakeupAdmission: boolean;
  observationEpoch?: symbol;
  recoveringThreads: Map<
    string,
    {
      epoch: symbol;
      clientIds: Set<string>;
      events: ServerNotificationParams["zen/thread/event"][];
      bytes: number;
      overflow: boolean;
    }
  >;
  timers: Map<string, { handle: unknown; scheduledAt: number }>;
  remoteWatches: Map<string, RemoteWatch>;
  completedTurnItems: Map<string, CompletedItemBuffer>;
  pendingCompletedTurns: Map<string, PendingCompletion>;
  activeWakeups: Map<string, ActiveWakeup>;
  programControllers: Map<string, AbortController>;
  disposeNotifications: (() => void) | undefined;
  disposeWakeupGate?: () => void;
  storageGateOpen?: boolean;
  storageGateEpoch?: symbol;
  storageWaiters: Set<() => void>;
}

interface RemoteWatch {
  id: string;
  definition: string;
  controller: AbortController;
  dispose?: () => void;
  ready: Promise<void>;
  error?: string;
}

export class ZenXTriggerService {
  readonly #manager: ZenXTriggerAppServerPort;
  readonly #receiptReads = new Map<
    string,
    Promise<ClientRequestResults["thread/read"]>
  >();
  readonly #store: ZenXTriggerStorePort;
  readonly #titles: ZenXTriggerTitlePort | undefined;
  readonly #wakeupGate:
    | {
        isOpen(): boolean;
        isBlockedError?(error: unknown): boolean;
        subscribe(listener: () => void): () => void;
      }
    | undefined;
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
    store: ZenXTriggerStorePort,
    options: {
      now?: () => number;
      schedule?: (callback: () => void, delayMs: number) => unknown;
      cancelScheduled?: (handle: unknown) => void;
      titles?: ZenXTriggerTitlePort;
      wakeupGate?: {
        isOpen(): boolean;
        isBlockedError?(error: unknown): boolean;
        subscribe(listener: () => void): () => void;
      };
      programs?: TriggerProgramRunner;
    } = {},
  ) {
    this.#manager = manager;
    this.#store = store;
    this.#titles = options.titles;
    this.#wakeupGate = options.wakeupGate;
    this.#programs = options.programs ?? new ZenXTriggerProgramRunner();
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelScheduled =
      options.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async start(
    wakeupAdmission = true,
    lifecycleStore: ZenXTriggerStorePort = this.#store,
  ): Promise<void> {
    if (this.#generation !== null) await this.stop(lifecycleStore);
    const generation = newGeneration(wakeupAdmission);
    this.#generation = generation;
    generation.disposeWakeupGate = this.#wakeupGate?.subscribe(() =>
      this.#refreshWakeupGate(generation),
    );
    try {
      await this.#mutation;
      const snapshot = await lifecycleStore.read();
      for (const entry of snapshot.history) {
        if (entry.status === "starting" || entry.status === "running") {
          if (entry.delivery !== undefined || entry.turnId !== null)
            entry.delivery = "unknown";
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
            entry.programOutcomes = appendProgramOutcome(
              entry.programOutcomes,
              outcome,
            );
            entry.programInvocationId = null;
          }
        }
      }
      await lifecycleStore.write(snapshot);
      this.#assertMutationGeneration(generation);
      this.#snapshot = snapshot;
      this.#syncRemoteWatches(generation);
      this.#notify();
      this.#rescheduleTimers(generation);
      this.#subscribeWakeups(generation);
      // Subscription recovery is one read-only pass. A slow/offline Thread
      // must not hold product startup or shutdown behind its RPC deadline.
      void this.#recoverWakeups(generation).catch((error) => {
        if (this.#isOperational(generation))
          console.warn(
            `Could not recover Trigger observation: ${describeError(error)}`,
          );
      });
    } catch (error) {
      generation.active = false;
      if (this.#generation === generation) this.#generation = null;
      generation.disposeWakeupGate?.();
      generation.disposeWakeupGate = undefined;
      generation.disposeNotifications?.();
      generation.disposeNotifications = undefined;
      this.#disposeRemoteWatches(generation);
      throw error;
    }
  }

  resumeWakeups(): void {
    const generation = this.#runningGeneration();
    if (generation.wakeupAdmission) return;
    generation.wakeupAdmission = true;
    this.#subscribeWakeups(generation);
    this.#syncRemoteWatches(generation);
    this.#rescheduleTimers(generation);
    void this.#recoverWakeups(generation).catch((error) => {
      if (this.#isOperational(generation))
        console.warn(
          `Could not recover Trigger observation: ${describeError(error)}`,
        );
    });
  }

  suspendWakeups(): void {
    const generation = this.#runningGeneration();
    if (!generation.wakeupAdmission) return;
    generation.wakeupAdmission = false;
    generation.observationEpoch = undefined;
    generation.recoveringThreads.clear();
    generation.disposeNotifications?.();
    generation.disposeNotifications = undefined;
    this.#disposeRemoteWatches(generation);
    for (const timer of generation.timers.values())
      this.#cancelScheduled(timer.handle);
    generation.timers.clear();
    for (const controller of generation.programControllers.values())
      controller.abort();
  }

  #refreshWakeupGate(generation: TriggerGeneration): void {
    if (!this.#isOperational(generation)) return;
    const epoch = Symbol("storage publication");
    generation.storageGateEpoch = epoch;
    generation.storageGateOpen = false;
    // Preserve dueAt and already admitted work: do not abort programs or replay
    // effects. Remove registrations so an elapsed timer can be scheduled anew.
    for (const timer of generation.timers.values())
      this.#cancelScheduled(timer.handle);
    generation.timers.clear();
    generation.observationEpoch = undefined;
    generation.recoveringThreads.clear();
    generation.disposeNotifications?.();
    generation.disposeNotifications = undefined;
    this.#disposeRemoteWatches(generation);
    if (!(this.#wakeupGate?.isOpen() ?? true)) return;
    const current = () =>
      this.#isOperational(generation) &&
      generation.storageGateEpoch === epoch &&
      (this.#wakeupGate?.isOpen() ?? true);
    // Reload the committed or rolled-back Host snapshot before scheduling.
    // Serialize with normal mutations; a candidate lifecycle snapshot is not
    // authoritative after rollback, even when the shared service survives.
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    void (async () => {
      try {
        await previous;
        if (!current()) return;
        const snapshot = await this.#store.read();
        if (!current()) return;
        this.#snapshot = snapshot;
        generation.storageGateOpen = true;
        this.#releaseStorageWaiters(generation);
        this.#notify();
        this.#subscribeWakeups(generation);
        this.#syncRemoteWatches(generation);
        this.#rescheduleTimers(generation);
        void this.#recoverWakeups(generation).catch((error) => {
          if (current())
            console.warn(
              `Could not recover Trigger observation: ${describeError(error)}`,
            );
        });
      } catch (error) {
        if (current()) {
          generation.storeUnavailable = true;
          this.#releaseStorageWaiters(generation);
          console.error(
            `Trigger storage publication could not be observed: ${describeError(error)}`,
          );
        }
      } finally {
        release();
      }
    })();
  }

  #subscribeWakeups(generation: TriggerGeneration): void {
    if (!this.#isWakeupOperational(generation)) return;
    const epoch = Symbol("trigger-observation");
    generation.observationEpoch = epoch;
    const current = () =>
      this.#isWakeupOperational(generation) &&
      generation.observationEpoch === epoch;
    const disposeNotifications = this.#manager.onNotification(
      (method, params) => {
        if (
          !this.#isWakeupOperational(generation) ||
          generation.observationEpoch !== epoch
        )
          return;
        if (method === "zen/thread/event") {
          const native = params as ServerNotificationParams["zen/thread/event"];
          const recovery = generation.recoveringThreads.get(native.threadId);
          if (recovery?.epoch === epoch && !recovery.overflow) {
            const event = native.event;
            const relevant =
              event.type === "turn_completed" ||
              (event.type === "queue_failed" &&
                recovery.clientIds.has(event.clientId)) ||
              (event.type === "item_completed" &&
                (event.item.type === "agent_message" ||
                  ((event.item.type === "host_message" ||
                    event.item.type === "host_message_queued" ||
                    event.item.type === "host_message_cancelled") &&
                    recovery.clientIds.has(event.item.clientId))));
            if (relevant) {
              const bytes = utf8Bytes(JSON.stringify(native));
              if (
                recovery.events.length === MAX_RECOVERY_EVENTS ||
                recovery.bytes + bytes > MAX_RECOVERY_BYTES
              ) {
                recovery.overflow = true;
                recovery.events = [];
              } else {
                recovery.bytes += bytes;
                recovery.events.push(native);
              }
            }
          }
          if (
            native.event.type === "item_completed" &&
            native.event.item.type === "host_message"
          ) {
            const item = native.event.item;
            const active = this.#observeHostWakeup(generation, item);
            if (
              !active &&
              this.#snapshot.history.some(
                (entry) =>
                  entry.threadId === item.threadId &&
                  entry.clientUserMessageId === item.clientId,
              )
            )
              return; // Rejected provenance or terminal history cannot feed completion correlation.
            if (active) {
              void this.#mutate(generation, async (snapshot) => {
                if (!current()) return;
                const entry = snapshot.history.find(
                  (entry) => entry.id === active.historyId,
                );
                if (
                  entry &&
                  (!isTerminal(entry.status) || entry.delivery === "unknown")
                ) {
                  entry.turnId = item.turnId;
                  entry.status = "running";
                  entry.completedAt = null;
                  entry.error = null;
                  delete entry.delivery;
                }
              }).catch((error: unknown) =>
                this.#markStoreUnavailable(generation, active.historyId, error),
              );
            }
            this.#handleItemCompleted(generation, {
              threadId: item.threadId,
              turnId: item.turnId,
              completedAtMs: new Date(item.createdAt).getTime(),
              item: {
                type: "hostMessage",
                id: item.id,
                clientId: item.clientId,
                source: item.source,
                text: item.text,
                mode: item.mode,
                ...(item.sourceId === undefined
                  ? {}
                  : { sourceId: item.sourceId }),
                ...(item.deliveryAfter === undefined
                  ? {}
                  : { deliveryAfter: item.deliveryAfter }),
              },
            });
          } else if (
            native.event.type === "item_completed" &&
            native.event.item.type === "agent_message"
          ) {
            const item = native.event.item;
            this.#handleItemCompleted(generation, {
              threadId: item.threadId,
              turnId: item.turnId,
              completedAtMs: new Date(item.createdAt).getTime(),
              item: {
                type: "agentMessage",
                id: item.id,
                text: item.text,
                phase: "final_answer",
                memoryCitation: null,
              },
            });
          } else if (native.event.type === "turn_completed") {
            const event = native.event;
            void (async () => {
              if (
                !this.#isPotentialTurn(generation, event.threadId, event.turnId)
              )
                return;
              let read: ClientRequestResults["thread/read"] | undefined;
              try {
                read = await this.#manager.readThread?.(event.threadId);
              } catch (error) {
                // The native terminal event and buffered canonical Items remain
                // valid even when an optional full-history read is unavailable.
                console.warn(
                  `Could not read completed Trigger context: ${describeError(error)}`,
                );
              }
              if (!current()) return;
              const turn = read?.thread.turns.find(
                (turn) => turn.id === event.turnId,
              );
              await this.#handleTurnCompleted(
                generation,
                {
                  threadId: event.threadId,
                  turn:
                    turn && turn.status !== "inProgress"
                      ? turn
                      : {
                          id: event.turnId,
                          status: event.status,
                          itemsView: "full",
                          error: null,
                          startedAt: null,
                          completedAt: this.#now() / 1000,
                          durationMs: null,
                          items:
                            generation.completedTurnItems.get(
                              transientTurnKey(event.threadId, event.turnId),
                            )?.items ?? [],
                        },
                },
                current,
              );
            })().catch((error: unknown) => {
              if (this.#isOperational(generation))
                console.warn(
                  `Could not process native Trigger completion: ${describeError(error)}`,
                );
            });
          } else if (
            native.event.type === "item_completed" &&
            native.event.item.type === "host_message_queued"
          ) {
            const item = native.event.item;
            const active = this.#observeHostWakeup(generation, item);
            if (active)
              void this.#mutate(generation, async (snapshot) => {
                if (!current()) return;
                const entry = snapshot.history.find(
                  (entry) => entry.id === active.historyId,
                );
                if (
                  !entry ||
                  entry.turnId !== null ||
                  entry.delivery === "failed" ||
                  entry.status === "completed"
                )
                  return;
                // Only a canonical queue Item (or its RPC receipt) confirms
                // acceptance. Unknown transport outcomes alone never do.
                entry.delivery = "queued";
                entry.status = "starting";
                entry.completedAt = null;
              }).catch((error) =>
                this.#markStoreUnavailable(generation, active.historyId, error),
              );
          } else if (
            native.event.type === "item_completed" &&
            native.event.item.type === "host_message_cancelled"
          ) {
            const item = native.event.item;
            const active = this.#observeHostWakeup(generation, item);
            if (active)
              void this.#failHistory(
                generation,
                active.historyId,
                "Host wakeup was cancelled before admission",
                { confirmedDeliveryFailure: true, isCurrent: current },
              ).catch((error: unknown) =>
                this.#markStoreUnavailable(generation, active.historyId, error),
              );
          } else if (
            native.event.type === "thread_deleted_updated" &&
            native.event.deleted
          ) {
            const threadId = native.event.threadId;
            void this.#mutate(generation, async (snapshot) => {
              if (!current()) return;
              for (const entry of snapshot.history) {
                if (
                  entry.threadId === threadId &&
                  (entry.delivery === "queued" || entry.delivery === "unknown")
                )
                  entry.error =
                    entry.delivery === "queued"
                      ? "The target Thread was deleted; its queued wakeup cannot be admitted unless the Thread is restored and resumed."
                      : "The target Thread was deleted; delivery remains unconfirmed and no wakeup was resent.";
              }
            }).catch((error) =>
              this.#markStoreUnavailable(generation, "", error),
            );
          } else if (native.event.type === "queue_failed") {
            const event = native.event;
            const observed = this.#snapshot.history.find(
              (entry) =>
                entry.threadId === event.threadId &&
                entry.clientUserMessageId === event.clientId,
            );
            if (!observed) return;
            // This reports one admission attempt, not removal from the Core
            // queue. Keep observing the accepted clientId without resending.
            void this.#mutate(generation, async (snapshot) => {
              if (!current()) return;
              const entry = snapshot.history.find(
                (entry) =>
                  entry.threadId === event.threadId &&
                  entry.clientUserMessageId === event.clientId,
              );
              if (
                !entry ||
                entry.turnId !== null ||
                entry.delivery === "failed" ||
                entry.status === "completed"
              )
                return;
              entry.error = bounded(event.message, MAX_ERROR_BYTES);
            }).catch((error: unknown) => {
              this.#markStoreUnavailable(generation, observed.id, error);
            });
          }
        } else if (method === "item/completed") {
          this.#handleItemCompleted(
            generation,
            params as ServerNotificationParams["item/completed"],
          );
        } else if (method === "turn/completed") {
          void this.#handleTurnCompleted(
            generation,
            params as ServerNotificationParams["turn/completed"],
            current,
          ).catch((error: unknown) => {
            if (this.#isOperational(generation))
              console.warn(
                `Could not process Trigger completion: ${describeError(error)}`,
              );
          });
        }
      },
    );
    const disposeReconnect = this.#manager.onReconnect?.(() => {
      void this.#recoverWakeups(generation).catch((error: unknown) => {
        if (this.#isOperational(generation))
          console.warn(
            `Could not reconcile Trigger completion: ${describeError(error)}`,
          );
      });
    });
    generation.disposeNotifications = () => {
      disposeNotifications();
      disposeReconnect?.();
    };
  }

  async #recoverWakeups(generation: TriggerGeneration): Promise<void> {
    const epoch = generation.observationEpoch;
    const current = () =>
      epoch !== undefined &&
      generation.observationEpoch === epoch &&
      this.#isWakeupOperational(generation);
    if (!current()) return;
    const candidates = this.#snapshot.history.filter(
      (entry) =>
        entry.delivery === "unknown" ||
        entry.delivery === "queued" ||
        (!isTerminal(entry.status) &&
          (entry.delivery === "pending" || entry.turnId !== null)),
    );
    for (const threadId of new Set(candidates.map((entry) => entry.threadId))) {
      if (!current()) return;
      const ids = new Set(
        candidates
          .filter((entry) => entry.threadId === threadId)
          .map((entry) => entry.id),
      );
      // Capture live facts before requesting the barrier: the transport may
      // emit them synchronously after resolving the RPC, before await resumes.
      // This selects observation only; history does not establish admission.
      const live = {
        epoch: epoch!,
        clientIds: new Set(
          candidates
            .filter((entry) => entry.threadId === threadId)
            .map((entry) => entry.clientUserMessageId),
        ),
        events: [] as ServerNotificationParams["zen/thread/event"][],
        bytes: 0,
        overflow: false,
      };
      generation.recoveringThreads.set(threadId, live);
      try {
        // Native resume is a read/subscribe barrier, not queue execution. The
        // Core remains the only owner of admission and durable queue state.
        const result = await this.#manager.request("zen/thread/resume", {
          threadId,
        });
        if (!current()) return;
        if (
          !("processEpoch" in result) ||
          result.threadId !== threadId ||
          result.thread.id !== threadId
        )
          throw new Error(
            "Native recovery did not return the requested Thread",
          );
        if (live.overflow)
          throw new Error(
            "Native recovery event buffer exceeded its bound; observation is unconfirmed",
          );
        const events = [...result.events, ...live.events].filter(
          (event) =>
            event.threadId === threadId &&
            event.processEpoch === result.processEpoch &&
            (event.event.type === "item_completed"
              ? event.event.item.threadId === threadId
              : "threadId" in event.event && event.event.threadId === threadId),
        );
        const items = [
          ...new Map(
            [
              ...result.thread.items,
              ...events.flatMap(({ event }) =>
                event.type === "item_completed" ? [event.item] : [],
              ),
            ]
              .filter((item) => item.threadId === threadId)
              .map((item) => [item.id, item] as const),
          ).values(),
        ];
        type HostItem = Extract<
          (typeof items)[number],
          { type: "host_message" | "host_message_queued" }
        >;
        const receiptFor = (entry: TriggerHistoryEntry) => {
          const owns = (item: HostItem) =>
            item.clientId === entry.clientUserMessageId &&
            item.source === this.#hostSource(entry).source &&
            item.sourceId === this.#hostSource(entry).sourceId;
          const queued = items.find(
            (
              item,
            ): item is Extract<HostItem, { type: "host_message_queued" }> =>
              item.type === "host_message_queued" && owns(item),
          );
          const admitted = items.find(
            (item): item is Extract<HostItem, { type: "host_message" }> =>
              item.type === "host_message" && owns(item),
          );
          const cancelled =
            queued !== undefined &&
            items.some(
              (item) =>
                item.type === "host_message_cancelled" &&
                item.queuedItemId === queued.id &&
                item.clientId === queued.clientId,
            );
          return { queued, admitted, cancelled };
        };
        const completedForTurn = (turnId: string): ThreadItem[] =>
          items.flatMap((candidate): ThreadItem[] => {
            if (!("turnId" in candidate) || candidate.turnId !== turnId)
              return [];
            if (candidate.type === "host_message")
              return [
                {
                  type: "hostMessage",
                  id: candidate.id,
                  clientId: candidate.clientId,
                  source: candidate.source,
                  sourceId: candidate.sourceId,
                  text: candidate.text,
                  mode: candidate.mode,
                },
              ];
            if (candidate.type === "agent_message")
              return [
                {
                  type: "agentMessage",
                  id: candidate.id,
                  text: candidate.text,
                  phase: "final_answer",
                  memoryCitation: null,
                },
              ];
            return [];
          });
        // Validate canonical provenance and establish observation/buffer order
        // synchronously, before any async projection write can hide live facts.
        for (const entry of this.#snapshot.history) {
          if (
            !ids.has(entry.id) ||
            (isTerminal(entry.status) && entry.delivery !== "unknown") ||
            entry.delivery === "failed"
          )
            continue;
          const receipt = receiptFor(entry);
          if (receipt.cancelled) continue;
          const item = receipt.admitted ?? receipt.queued;
          if (!item || !this.#observeHostWakeup(generation, item)) continue;
          if (item.type === "host_message") {
            for (const completed of completedForTurn(item.turnId))
              this.#handleItemCompleted(generation, {
                threadId,
                turnId: item.turnId,
                completedAtMs: this.#now(),
                item: completed,
              });
          }
        }
        // Subsequent live events now use the validated observer and normal
        // completion barrier; replaying snapshot Items later would reorder them.
        generation.recoveringThreads.delete(threadId);
        const observed: Array<{ historyId: string; item: HostItem }> = [];
        const cancelled: string[] = [];
        await this.#mutate(generation, async (snapshot) => {
          if (!current()) return;
          for (const entry of snapshot.history) {
            if (
              !ids.has(entry.id) ||
              (isTerminal(entry.status) && entry.delivery !== "unknown") ||
              entry.delivery === "failed"
            )
              continue;
            const {
              queued,
              admitted,
              cancelled: isCancelled,
            } = receiptFor(entry);
            if (isCancelled) {
              entry.status = "failed";
              entry.delivery = "failed";
              entry.completedAt = this.#now();
              entry.error = "Host wakeup was cancelled before admission";
              cancelled.push(entry.id);
            } else if (admitted) {
              entry.turnId = admitted.turnId;
              entry.status = "running";
              entry.completedAt = null;
              entry.error = null;
              delete entry.delivery;
              observed.push({ historyId: entry.id, item: admitted });
            } else if (queued && entry.turnId === null) {
              entry.status = "starting";
              entry.delivery = "queued";
              entry.completedAt = null;
              const failed = events
                .map(({ event }) => event)
                .findLast(
                  (event) =>
                    event.type === "queue_failed" &&
                    event.clientId === queued.clientId &&
                    event.queuedItemId === queued.id,
                );
              entry.error =
                failed?.type === "queue_failed"
                  ? bounded(failed.message, MAX_ERROR_BYTES)
                  : result.thread.archived
                    ? "Queued wakeup remains pending in an archived Thread; unarchive and resume it to continue."
                    : null;
              observed.push({ historyId: entry.id, item: queued });
            } else if (
              entry.delivery === "unknown" ||
              entry.delivery === "pending"
            ) {
              entry.status = "failed";
              entry.delivery = "unknown";
              entry.error =
                "No matching canonical Host receipt was found; delivery remains unconfirmed and no wakeup was resent.";
            }
          }
        });
        if (!current()) return;
        for (const historyId of cancelled)
          this.#releaseActiveWakeup(generation, historyId);
        for (const { historyId, item } of observed) {
          if (!current()) return;
          const active = this.#observeHostWakeup(generation, item);
          if (!active || item.type !== "host_message") continue;
          const completedItems = completedForTurn(item.turnId);
          const terminal = events
            .map(({ event }) => event)
            .findLast(
              (event) =>
                event.type === "turn_completed" && event.turnId === item.turnId,
            );
          const status =
            terminal?.type === "turn_completed"
              ? terminal.status
              : result.thread.turns.find((turn) => turn.id === item.turnId)
                  ?.status;
          if (status && status !== "inProgress") {
            await this.#completeTurn(
              generation,
              historyId,
              {
                threadId,
                turn: {
                  id: item.turnId,
                  status,
                  itemsView: "full",
                  items: completedItems,
                  error: null,
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                },
              },
              completedItems,
              current,
            );
          }
        }
      } catch (error) {
        if (!current()) return;
        await this.#mutate(generation, async (snapshot) => {
          if (!current()) return;
          for (const entry of snapshot.history) {
            if (
              ids.has(entry.id) &&
              entry.status !== "completed" &&
              entry.delivery !== "failed"
            )
              entry.error = bounded(
                `Could not restore canonical Host observation: ${describeError(error)}. No wakeup was resent; enable Triggers again to retry observation.`,
                MAX_ERROR_BYTES,
              );
          }
        });
      } finally {
        if (generation.recoveringThreads.get(threadId) === live)
          generation.recoveringThreads.delete(threadId);
      }
    }
  }

  async stop(
    lifecycleStore: ZenXTriggerStorePort = this.#store,
  ): Promise<void> {
    const generation = this.#generation;
    if (generation === null) return;
    generation.retiring = true;
    this.#releaseStorageWaiters(generation);
    this.#disposeRemoteWatches(generation);
    for (const controller of generation.programControllers.values())
      controller.abort();
    try {
      await this.#mutate(
        generation,
        async (snapshot) => {
          for (const entry of snapshot.history) {
            if (isTerminal(entry.status)) continue;
            entry.status = "failed";
            if (entry.delivery !== undefined || entry.turnId !== null)
              entry.delivery = "unknown";
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
              entry.programOutcomes = appendProgramOutcome(
                entry.programOutcomes,
                outcome,
              );
              entry.programInvocationId = null;
            }
          }
          generation.activeWakeups.clear();
          return undefined;
        },
        true,
        undefined,
        lifecycleStore,
      );
    } finally {
      generation.active = false;
      if (this.#generation === generation) this.#generation = null;
      generation.disposeWakeupGate?.();
      generation.disposeWakeupGate = undefined;
      generation.disposeNotifications?.();
      generation.disposeNotifications = undefined;
      for (const timer of generation.timers.values())
        this.#cancelScheduled(timer.handle);
      generation.timers.clear();
      generation.recoveringThreads.clear();
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
    const snapshot = structuredClone(this.#snapshot);
    for (const trigger of snapshot.triggers) {
      const error = this.#generation?.remoteWatches.get(trigger.id)?.error;
      if (error !== undefined) trigger.sourceError = error;
    }
    return snapshot;
  }

  sidebarFacts(): TriggerSidebarSnapshot {
    // Project directly from the bounded registry before any snapshot clone.
    // In particular, never visit Room bodies, history, prompt, or program data.
    return {
      triggers: this.#snapshot.triggers.map((trigger) => ({
        id: trigger.id,
        threadId: trigger.threadId,
        kind: trigger.kind,
        active: trigger.active,
        ...(trigger.timer === undefined
          ? {}
          : { timer: { nextRunAt: trigger.timer.nextRunAt } }),
        ...(this.#generation?.remoteWatches.get(trigger.id)?.error ===
          undefined && trigger.sourceError === undefined
          ? {}
          : { sourceError: "Source observation unavailable" as const }),
      })),
    };
  }

  onChange(listener: (snapshot: TriggerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async create(input: CreateTriggerInput): Promise<ZenXTrigger> {
    const generation = this.#runningGeneration();
    if (isRemoteWatchInput(input) && !this.#manager.subscribeRemoteThread)
      throw new Error("Remote Thread observation is unavailable");
    if (
      input.kind === "thread" &&
      input.includeLatest &&
      !isRemoteWatchInput(input) &&
      this.#manager.readThread === undefined
    )
      throw new Error("Reading the latest Thread result is unavailable");
    const triggerId = randomUUID();
    const trigger = await this.#mutate(
      generation,
      async (snapshot) => {
        if (snapshot.triggers.length >= MAX_TRIGGER_COUNT)
          throw new Error(`ZenX Trigger limit is ${String(MAX_TRIGGER_COUNT)}`);
        const value = triggerFromInput(
          input,
          triggerId,
          this.#now(),
          true,
          this.#now(),
        );
        snapshot.triggers.push(value);
        return value;
      },
      false,
      input.kind === "thread" && input.includeLatest ? triggerId : undefined,
    );
    this.#rescheduleTimers(generation);
    if (isRemoteWatchInput(input)) {
      await generation.remoteWatches.get(trigger.id)?.ready;
    } else if (input.kind === "thread" && input.includeLatest) {
      try {
        // Install first, then read: a completion racing this read goes through
        // the same occurrence key as the live event, never a second send.
        const result = await this.#manager.readThread!(input.watchedThreadId);
        const latest = result.thread.turns.at(-1);
        if (latest !== undefined && latest.status !== "inProgress")
          await this.#fireThreadCompletion(
            generation,
            trigger.id,
            input.watchedThreadId,
            latest,
            trigger.definitionRevision ?? 0,
          );
      } catch (error) {
        await this.cancel(trigger.id);
        throw new Error(
          `Latest result could not be checked; watch ${trigger.id} was stopped: ${describeError(error)}`,
        );
      }
    }
    return structuredClone(
      this.snapshot().triggers.find((entry) => entry.id === trigger.id)!,
    );
  }

  async update(input: UpdateTriggerInput): Promise<ZenXTrigger> {
    if (input.kind === "thread" && input.includeLatest)
      throw new Error(
        "includeLatest is only supported when creating a new watch",
      );
    const generation = this.#runningGeneration();
    const trigger = await this.#mutate(generation, async (snapshot) => {
      const index = snapshot.triggers.findIndex(
        (candidate) => candidate.id === input.id,
      );
      if (index < 0) throw new Error("Trigger was not found");
      if (snapshot.rooms.some((room) => room.assistant?.triggerId === input.id))
        throw new Error(
          "Assistant routing is fixed; pause replies or create a new conversation",
        );
      const heartbeatOwner = snapshot.rooms.find(
        (room) => room.assistant?.heartbeatTriggerId === input.id,
      );
      if (
        heartbeatOwner &&
        (input.kind !== "timer" ||
          input.threadId !== heartbeatOwner.assistant!.threadId)
      )
        throw new Error(
          "A PAW heartbeat must remain a timer for its working Thread; delete it to detach the preset",
        );
      const existing = snapshot.triggers[index]!;
      const replacement = triggerFromInput(
        input,
        existing.id,
        existing.createdAt,
        existing.active,
        this.#now(),
      );
      replacement.definitionRevision = (existing.definitionRevision ?? 0) + 1;
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
      trigger.definitionRevision = (trigger.definitionRevision ?? 0) + 1;
    });
    this.#rescheduleTimers(generation);
  }

  async resume(
    triggerId: string,
    expectedDefinition?: ZenXTrigger | number,
  ): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const trigger = snapshot.triggers.find(
        (item) => item.id === required(triggerId, "trigger"),
      );
      if (trigger === undefined) throw new Error("Trigger was not found");
      if (
        expectedDefinition !== undefined &&
        (typeof expectedDefinition === "number"
          ? (trigger.definitionRevision ?? 0) !== expectedDefinition
          : JSON.stringify(trigger) !==
            JSON.stringify(withoutSourceError(expectedDefinition)))
      )
        throw new Error(
          "Trigger definition changed during validation; refresh before enabling",
        );
      if (
        trigger.active &&
        !(
          trigger.watch?.sourceDevice !== undefined &&
          generation.remoteWatches.get(trigger.id)?.error !== undefined
        )
      )
        return;
      if (trigger.timer !== undefined && trigger.timer.nextRunAt <= this.#now())
        throw new Error(
          "Timer is in the past; edit the next run time before resuming",
        );
      trigger.active = true;
      trigger.definitionRevision = (trigger.definitionRevision ?? 0) + 1;
    });
    this.#rescheduleTimers(generation);
  }

  async delete(triggerId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const normalized = required(triggerId, "trigger");
      const index = snapshot.triggers.findIndex(
        (item) => item.id === normalized,
      );
      if (index < 0) throw new Error("Trigger was not found");
      if (
        snapshot.rooms.some((room) => room.assistant?.triggerId === normalized)
      )
        throw new Error(
          "Assistant reply Trigger is owned by its Room; pause it or delete the Room",
        );
      snapshot.triggers.splice(index, 1);
      for (const room of snapshot.rooms)
        if (room.assistant?.heartbeatTriggerId === normalized)
          delete room.assistant.heartbeatTriggerId;
    });
    this.#rescheduleTimers(generation);
  }

  async signal(name: string, detail: string): Promise<void> {
    const generation = this.#runningGeneration();
    const signalName = required(name, "signal name", MAX_ID_BYTES);
    const signalDetail = bounded(detail.trim(), MAX_REASON_BYTES);
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
        reason: `External signal ${signalName}: ${signalDetail}`,
        occurrenceKey: `signal:${randomUUID()}`,
        projection: `Signal name: ${signalName}\nSignal detail: ${signalDetail}`,
      });
    }
  }

  async createRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    const generation = this.#runningGeneration();
    const room = await this.#mutate(generation, async (snapshot) => {
      if (snapshot.rooms.length >= MAX_ROOM_COUNT)
        throw new Error(`ZenX Room limit is ${String(MAX_ROOM_COUNT)}`);
      const value: ZenXRoom = {
        id: randomUUID(),
        name: required(input.name, "room name", MAX_ROOM_NAME_BYTES),
        members: validateMembers(input.members),
        messages: [],
        operations: [],
        operationEpoch: randomUUID(),
        createdAt: this.#now(),
      };
      snapshot.rooms.push(value);
      return value;
    });
    return structuredClone(room);
  }

  /** Validate setup before the Host creates an optional underlying Thread. */
  validateAssistantRoom(input: CreateRoomInput): CreateRoomInput {
    const generation = this.#runningGeneration();
    if (!generation.wakeupAdmission)
      throw new Error("Enable Triggers before creating an assistant");
    const name = required(input.name, "room name", MAX_ROOM_NAME_BYTES);
    const members = validateMembers(input.members);
    if (members.length !== 1)
      throw new Error("An assistant needs exactly one Thread");
    if (
      this.#snapshot.rooms.length >= MAX_ROOM_COUNT ||
      this.#snapshot.triggers.length + 2 > MAX_TRIGGER_COUNT
    )
      throw new Error("Room or Trigger limit reached");
    return { name, members };
  }

  async createAssistantRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    const generation = this.#runningGeneration();
    const { name, members } = this.validateAssistantRoom(input);
    const created = await this.#mutate(generation, async (snapshot) => {
      if (!generation.wakeupAdmission)
        throw new Error("Triggers are not enabled");
      if (
        snapshot.rooms.length >= MAX_ROOM_COUNT ||
        snapshot.triggers.length + 2 > MAX_TRIGGER_COUNT
      )
        throw new Error("Room or Trigger limit reached");
      const member = members[0]!;
      const id = randomUUID();
      const trigger = triggerFromInput(
        {
          kind: "roomMention",
          threadId: member.threadId,
          roomId: id,
          mention: member.name,
          label: "PAW",
          prompt: ALWAYS_ON_ASSISTANT_PROMPT,
        },
        randomUUID(),
        this.#now(),
        true,
        this.#now(),
      );
      const room: ZenXRoom = {
        id,
        name,
        members,
        assistant: { threadId: member.threadId, triggerId: trigger.id },
        messages: [],
        operations: [],
        operationEpoch: randomUUID(),
        createdAt: this.#now(),
      };
      const heartbeat = newAssistantHeartbeat(room, this.#now());
      room.assistant!.heartbeatTriggerId = heartbeat.id;
      snapshot.rooms.push(room);
      snapshot.triggers.push(trigger, heartbeat);
      return structuredClone(room);
    });
    this.#rescheduleTimers(generation);
    return created;
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (candidate) => candidate.id === required(roomId, "room", MAX_ID_BYTES),
      );
      if (room === undefined) throw new Error("Room was not found");
      const nextName = required(
        name,
        room.assistant ? "PAW name" : "room name",
        room.assistant ? MAX_MEMBER_NAME_BYTES : MAX_ROOM_NAME_BYTES,
      );
      if (room.assistant) {
        const member = room.members.find(
          (value) => value.threadId === room.assistant!.threadId,
        );
        const trigger = snapshot.triggers.find(
          (value) => value.id === room.assistant!.triggerId,
        );
        if (!member || !trigger?.room)
          throw new Error("PAW identity is unavailable");
        member.name = nextName;
        trigger.room.mention = nextName;
      }
      room.name = nextName;
    });
  }

  async addAssistantHeartbeat(roomId: string): Promise<ZenXTrigger> {
    const generation = this.#runningGeneration();
    const heartbeat = await this.#mutate(generation, async (snapshot) => {
      if (!generation.wakeupAdmission)
        throw new Error("Enable Triggers before adding a heartbeat");
      const room = snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room", MAX_ID_BYTES),
      );
      if (!room?.assistant) throw new Error("PAW Room was not found");
      const existing = snapshot.triggers.find(
        (entry) => entry.id === room.assistant!.heartbeatTriggerId,
      );
      if (existing) return structuredClone(existing);
      if (snapshot.triggers.length >= MAX_TRIGGER_COUNT)
        throw new Error("Trigger limit reached");
      const trigger = newAssistantHeartbeat(room, this.#now());
      room.assistant.heartbeatTriggerId = trigger.id;
      snapshot.triggers.push(trigger);
      return structuredClone(trigger);
    });
    this.#rescheduleTimers(generation);
    return heartbeat;
  }
  async setAssistantDeliveryMode(
    roomId: string,
    mode: WakeupDeliveryMode,
  ): Promise<void> {
    const deliveryMode = validateDeliveryMode(mode);
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find((entry) => entry.id === roomId);
      if (!room?.assistant) throw new Error("Assistant Room was not found");
      room.assistant.deliveryMode = deliveryMode;
    });
  }

  assistantWorkspace(roomId: string): AssistantWorkspace {
    const room = this.#snapshot.rooms.find(
      (candidate) => candidate.id === required(roomId, "room", MAX_ID_BYTES),
    );
    if (!room?.assistant) throw Error("PAW assistant Room was not found");
    return structuredClone(
      room.assistantWorkspace ?? {
        revision: 0,
        updatedAt: 0,
        matters: [],
        memory: [],
      },
    );
  }
  async updateAssistantWorkspace(
    input: UpdateAssistantWorkspaceInput,
  ): Promise<AssistantWorkspace> {
    if (
      !input ||
      Object.keys(input).some(
        (key) =>
          !["roomId", "expectedRevision", "matters", "memory"].includes(key),
      ) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw Error("Invalid PAW workspace update fields or revision");
    const roomId = required(input.roomId, "room", MAX_ID_BYTES);
    const expectedRevision = input.expectedRevision;
    const draft = canonicalAssistantWorkspace({
      revision: 0,
      updatedAt: 0,
      matters: input.matters,
      memory: input.memory,
    });
    const generation = this.#runningGeneration();
    const result = await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find((entry) => entry.id === roomId);
      if (!room?.assistant) throw Error("PAW assistant Room was not found");
      const currentRevision = room.assistantWorkspace?.revision ?? 0;
      if (currentRevision !== expectedRevision)
        throw Object.assign(
          Error("PAW workspace changed; refresh before saving"),
          { code: "workspace_conflict", currentRevision },
        );
      if (currentRevision === Number.MAX_SAFE_INTEGER)
        throw Error("PAW workspace revision limit reached");
      const workspace = canonicalAssistantWorkspace({
        ...draft,
        revision: currentRevision + 1,
        updatedAt: this.#now(),
      });
      room.assistantWorkspace = workspace;
      return workspace;
    });
    return structuredClone(result);
  }

  async deleteRoom(roomId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const normalized = required(roomId, "room", MAX_ID_BYTES);
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
      if (room.assistant && !generation.wakeupAdmission)
        throw new Error(
          "Enable Triggers before deleting an assistant Room and its reply Trigger",
        );
      if (room.assistant)
        snapshot.triggers = snapshot.triggers.filter(
          (trigger) =>
            trigger.id !== room.assistant!.triggerId &&
            trigger.id !== room.assistant!.heartbeatTriggerId,
        );
      snapshot.rooms = snapshot.rooms.filter(
        (candidate) => candidate.id !== normalized,
      );
    });
    this.#rescheduleTimers(generation);
  }

  async addRoomMember(roomId: string, member: RoomMember): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room", MAX_ID_BYTES),
      );
      if (room === undefined) throw new Error("Room was not found");
      if (room.assistant)
        throw new Error(
          "Assistant membership is fixed; create a separate conversation",
        );
      room.members = validateMembers([...room.members, member]);
    });
  }

  async removeRoomMember(roomId: string, threadId: string): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === required(roomId, "room", MAX_ID_BYTES),
      );
      if (room === undefined) throw new Error("Room was not found");
      if (room.assistant)
        throw new Error(
          "Assistant membership is fixed; pause replies or delete the Room",
        );
      const normalized = required(threadId, "member thread", MAX_ID_BYTES);
      if (!room.members.some((member) => member.threadId === normalized))
        throw new Error("Room member was not found");
      room.members = room.members.filter(
        (member) => member.threadId !== normalized,
      );
    });
  }

  async prepareRoomMessage(
    roomId: string,
    operationId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<RoomSendOperation> {
    return this.#prepareRoomOperation(
      roomId,
      operationId,
      text,
      replyToMessageId,
    );
  }

  /** Explicit UI send through the existing Room receipt/wakeup admission path. */
  async postAddressedRoomMessage(
    roomId: string,
    threadId: string,
    operationId: string,
    text: string,
  ): Promise<RoomDeliveryView> {
    await this.#prepareRoomOperation(
      roomId,
      operationId,
      text,
      undefined,
      undefined,
      threadId,
    );
    await this.postPreparedRoomMessage(roomId, operationId, text);
    return this.roomOperation(roomId, operationId);
  }

  async prepareAssistantIntroduction(
    roomId: string,
    operationId: string,
    language: "en" | "zh",
  ): Promise<RoomSendOperation> {
    if (language !== "en" && language !== "zh")
      throw new Error("Unsupported welcome language");
    const text = [
      "This is a Host bootstrap event for a newly created PAW, not a message from the user.",
      "Proactively send a brief, natural welcome to the Reply Room using zenx_rooms_post_message, and ask what name the user would like to give you. Naming is optional; they can start working immediately.",
      "When they choose a name, use zenx_rooms_rename and confirm only after it succeeds. Do not choose a name for them or repeat this welcome after they have already replied.",
      language === "zh"
        ? "Write the welcome in Chinese."
        : "Write the welcome in English.",
    ].join("\n");
    return this.#prepareRoomOperation(
      roomId,
      operationId,
      text,
      undefined,
      "assistantIntroduction",
    );
  }

  async #prepareRoomOperation(
    roomId: string,
    operationId: string,
    text: string,
    replyToMessageId?: string,
    kind?: "assistantIntroduction",
    recipientThreadId?: string,
  ): Promise<RoomSendOperation> {
    const generation = this.#runningGeneration();
    const id = required(operationId, "operation ID", MAX_ID_BYTES);
    const normalizedText = required(text, "message", MAX_MESSAGE_TEXT_BYTES);
    return await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find((entry) => entry.id === roomId);
      if (!room) throw new Error("Room was not found");
      if (kind && !room.assistant)
        throw new Error("PAW assistant Room was not found");
      const operations = (room.operations ??= []);
      const existing = operations.find((operation) => operation.id === id);
      if (existing) {
        if (existing.cancelled === true)
          throw new Error("Room operation was cancelled; no message was sent");
        if (
          existing.recipientThreadId !== recipientThreadId ||
          existing.kind !== kind ||
          (kind === undefined && existing.text !== normalizedText) ||
          existing.replyTo?.messageId !== replyToMessageId
        )
          throw new Error("Operation is bound to a different message");
        return structuredClone(existing);
      }
      if (recipientThreadId !== undefined)
        this.#assertAddressedRoomRecipient(
          snapshot,
          room,
          recipientThreadId,
          generation,
        );
      const epoch = room.operationEpoch ?? "legacy";
      const suffix = id.startsWith(`${epoch}:`)
        ? id.slice(epoch.length + 1)
        : "";
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          suffix,
        )
      )
        throw new Error(
          "Room operation key is stale or invalid; result unknown, refresh before a NEW send",
        );
      room.operationEpoch ??= epoch;
      let evicted = false;
      while (operations.length >= MAX_ROOM_OPERATIONS) {
        const index = operations.findIndex((entry) => entry.acknowledged);
        if (index < 0) break;
        operations.splice(index, 1);
        evicted = true;
      }
      if (evicted) room.operationEpoch = randomUUID();
      if (operations.length >= MAX_ROOM_OPERATIONS)
        throw new Error(
          "Unresolved Room operation limit reached; review pending sends",
        );
      const replyTo =
        replyToMessageId === undefined
          ? undefined
          : roomQuote(room, replyToMessageId);
      const value: RoomSendOperation = {
        ...(recipientThreadId === undefined ? {} : { recipientThreadId }),
        ...(kind === undefined ? {} : { kind }),
        ...(replyTo === undefined ? {} : { replyTo }),
        id,
        text: normalizedText,
        messageId: null,
        createdAt: this.#now(),
        acknowledged: false,
        mentions: [],
      };
      operations.push(value);
      return structuredClone(value);
    });
  }

  async startAssistantIntroduction(
    roomId: string,
    operationId: string,
  ): Promise<RoomSendOperation> {
    const generation = this.#runningGeneration();
    const committed = await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find((entry) => entry.id === roomId);
      if (!room?.assistant) throw new Error("PAW assistant Room was not found");
      const operation = room.operations?.find(
        (entry) => entry.id === operationId,
      );
      if (operation?.kind !== "assistantIntroduction")
        throw new Error("PAW welcome operation is unavailable");
      if (operation.cancelled) throw new Error("PAW welcome was cancelled");
      if (operation.wakeupId) return { operation: structuredClone(operation) };
      if (!generation.wakeupAdmission)
        throw new Error("PAW proactive welcome is unavailable on this Host");
      const trigger = snapshot.triggers.find(
        (entry) => entry.id === room.assistant!.triggerId && entry.active,
      );
      if (!trigger)
        throw new Error(
          "PAW replies are paused; resume before starting its welcome",
        );
      const occurrenceKey = `paw-bootstrap:${room.id}:${operation.id}`;
      const wakeup = this.#commitWakeup(snapshot, trigger.id, {
        reason: "Host bootstrap: welcome the user and ask for a PAW name",
        occurrenceKey,
        sourceRoomId: room.id,
        projection: projectRoomContext(room),
        bootstrapText: operation.text,
      });
      const history = snapshot.history.find(
        (entry) =>
          entry.clientUserMessageId ===
          stableWakeupId(trigger.id, occurrenceKey),
      );
      if (!history) throw new Error("PAW welcome was not admitted");
      operation.wakeupId = history.id;
      operation.mentions = [
        {
          name: room.name,
          threadId: room.assistant.threadId,
          triggerIds: [trigger.id],
        },
      ];
      return { operation: structuredClone(operation), wakeup };
    });
    if (committed.wakeup && !("rejected" in committed.wakeup))
      await this.#runCommittedWakeup(generation, committed.wakeup);
    return committed.operation;
  }

  async postPreparedRoomMessage(
    roomId: string,
    operationId: string,
    text: string,
  ): Promise<RoomSendOperation> {
    const operation = await this.#postRoomMessage(
      roomId,
      "You",
      text,
      "human",
      null,
      null,
      operationId,
    );
    if (!operation) throw new Error("Room operation is unavailable");
    return operation;
  }

  async cancelPreparedRoomOperation(
    roomId: string,
    operationId: string,
  ): Promise<RoomDeliveryView> {
    const generation = this.#runningGeneration();
    const normalizedRoomId = required(roomId, "room", MAX_ID_BYTES);
    const id = required(operationId, "operation ID", MAX_ID_BYTES);
    return await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === normalizedRoomId,
      );
      if (!room) throw new Error("Room was not found");
      const operation = room.operations?.find((entry) => entry.id === id);
      if (!operation)
        throw new Error("Room operation is not retained; result unknown");
      if (
        operation.cancelled !== true &&
        (operation.messageId !== null || operation.wakeupId !== undefined)
      )
        throw new Error(
          operation.wakeupId
            ? "Cannot cancel an admitted PAW welcome"
            : `Cannot cancel a saved Room message: ${operation.messageId}`,
        );
      operation.cancelled = true;
      operation.acknowledged = true;
      return {
        operationId: operation.id,
        roomId: normalizedRoomId,
        text: operation.text,
        messageId: null,
        state: "cancelled" as const,
        createdAt: operation.createdAt,
        mentions: [],
      };
    });
  }

  wakeupsEnabled(): boolean {
    return (
      this.#generation?.wakeupAdmission === true && this.#generation.active
    );
  }

  roomOperation(roomId: string, operationId: string): RoomDeliveryView {
    const snapshot = this.#snapshot;
    const room = snapshot.rooms.find((entry) => entry.id === roomId);
    if (!room) throw new Error("Room was not found");
    const operation = room.operations?.find(
      (entry) => entry.id === operationId,
    );
    if (!operation)
      throw new Error("Room operation is not retained; result unknown");
    return {
      ...(operation.kind === undefined ? {} : { kind: operation.kind }),
      ...(operation.wakeupId === undefined
        ? {}
        : { wakeupId: operation.wakeupId }),
      operationId: operation.id,
      roomId,
      text: operation.text,
      messageId: operation.messageId,
      state:
        operation.cancelled === true
          ? "cancelled"
          : operation.messageId === null && operation.wakeupId === undefined
            ? "prepared"
            : "saved",
      createdAt: operation.createdAt,
      mentions: operation.mentions.map((mention) => ({
        name: mention.name,
        threadId: mention.threadId,
        configuredNow:
          this.wakeupsEnabled() &&
          snapshot.triggers.some(
            (trigger) =>
              trigger.active &&
              trigger.kind === "roomMention" &&
              trigger.threadId === mention.threadId &&
              trigger.room?.roomId === roomId &&
              trigger.room.mention.toLocaleLowerCase() ===
                mention.name.toLocaleLowerCase(),
          ),
        deliveries:
          mention.triggerIds.length === 0
            ? [
                {
                  triggerId: "",
                  status: "unconfigured" as const,
                  historyId: null,
                },
              ]
            : mention.triggerIds.map((triggerId) => {
                const entry = snapshot.history.find(
                  (history) =>
                    history.triggerId === triggerId &&
                    history.sourceRoomId === roomId &&
                    (operation.wakeupId
                      ? history.id === operation.wakeupId
                      : history.sourceRoomMessageId === operation.messageId),
                );
                return {
                  triggerId,
                  status:
                    entry === undefined
                      ? ("unknown" as const)
                      : entry.delivery === "unknown"
                        ? ("unknown" as const)
                        : entry.status === "failed" ||
                            (entry.delivery === "queued" &&
                              entry.error !== null)
                          ? ("failed" as const)
                          : entry.status === "completed"
                            ? ("completed" as const)
                            : entry.delivery === "queued"
                              ? ("queued" as const)
                              : entry.status === "running"
                                ? ("running" as const)
                                : ("pending" as const),
                  historyId: entry?.id ?? null,
                };
              }),
      })),
    };
  }

  roomDelivery(
    roomId: string,
    messageId: string,
  ):
    | RoomDeliveryView
    | { roomId: string; messageId: string; state: "unknown"; mentions: [] } {
    const room = this.#snapshot.rooms.find((entry) => entry.id === roomId);
    if (!room) throw new Error("Room was not found");
    const operation = room.operations?.find(
      (entry) => entry.messageId === messageId,
    );
    return operation
      ? this.roomOperation(roomId, operation.id)
      : { roomId, messageId, state: "unknown", mentions: [] };
  }

  #readReceiptThread(
    threadId: string,
  ): Promise<ClientRequestResults["thread/read"]> {
    const active = this.#receiptReads.get(threadId);
    if (active) return active;
    const read = Promise.resolve().then(() =>
      this.#manager.readThread!(threadId),
    );
    this.#receiptReads.set(threadId, read);
    void read
      .finally(() => {
        if (this.#receiptReads.get(threadId) === read)
          this.#receiptReads.delete(threadId);
      })
      .catch(() => {});
    return read;
  }

  /** Room storage and canonical Thread input admission are distinct receipts. */
  async roomMessageReceipt(roomId: string, messageId: string) {
    const room = this.#snapshot.rooms.find((entry) => entry.id === roomId);
    if (!room) throw new Error("Room was not found");
    const delivery = this.roomDelivery(roomId, messageId);
    const retained = room.messages.some((entry) => entry.id === messageId);
    if (!retained && delivery.state !== "saved")
      return { ...delivery, receipt: "unknown" as const, readers: [] };
    const histories = this.#snapshot.history.filter(
      (entry) =>
        entry.sourceRoomId === roomId &&
        entry.sourceRoomMessageId === messageId,
    );
    const recipients = new Map<string, string>();
    for (const mention of delivery.mentions)
      recipients.set(mention.threadId, mention.name);
    for (const history of histories)
      if (!recipients.has(history.threadId))
        recipients.set(
          history.threadId,
          room.members.find((member) => member.threadId === history.threadId)
            ?.name ?? history.threadId,
        );
    const readers = await Promise.all(
      [...recipients].map(async ([threadId, name]) => {
        try {
          const clientIds = new Set(
            histories
              .filter((entry) => entry.threadId === threadId)
              .map((entry) => entry.clientUserMessageId),
          );
          if (clientIds.size === 0 || !this.#manager.readThread)
            return { threadId, name, state: "unconfirmed" as const };
          const result = await this.#readReceiptThread(threadId);
          if (result.thread.id !== threadId)
            throw new Error("Receipt Thread identity mismatch");
          const admitted = result.thread.turns.some((turn) =>
            turn.items.some(
              (item) =>
                (item.type === "userMessage" || item.type === "hostMessage") &&
                item.clientId !== null &&
                clientIds.has(item.clientId),
            ),
          );
          return {
            threadId,
            name,
            state: admitted ? ("read" as const) : ("unconfirmed" as const),
          };
        } catch {
          return { threadId, name, state: "unavailable" as const };
        }
      }),
    );
    return { ...delivery, receipt: "delivered" as const, readers };
  }

  async setRoomReaction(
    roomId: string,
    messageId: string,
    actorThreadId: string | null,
    emoji: string | null,
  ): Promise<RoomMessage> {
    if (
      emoji !== null &&
      !(ROOM_REACTION_EMOJI as readonly string[]).includes(emoji)
    )
      throw new Error("Unsupported Room reaction");
    const generation = this.#runningGeneration();
    return await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find((entry) => entry.id === roomId);
      if (!room) throw new Error("Room was not found");
      const member =
        actorThreadId === null
          ? undefined
          : room.members.find((entry) => entry.threadId === actorThreadId);
      if (actorThreadId !== null && !member)
        throw new Error("Only a Room member can react as an Agent");
      const message = room.messages.find((entry) => entry.id === messageId);
      if (!message) throw new Error("Room message is no longer retained");
      const actorId =
        actorThreadId === null ? "user" : `thread:${actorThreadId}`;
      const reactions = (message.reactions ?? []).filter(
        (entry) => entry.actorId !== actorId,
      );
      if (emoji !== null) {
        if (reactions.length >= MAX_ROOM_MEMBERS + 1)
          throw new Error("Room reaction limit reached");
        reactions.push({ actorId, label: member?.name ?? "You", emoji });
      }
      if (reactions.length === 0) delete message.reactions;
      else message.reactions = reactions;
      return structuredClone(message);
    });
  }

  async acknowledgeRoomOperation(
    roomId: string,
    operationId: string,
  ): Promise<void> {
    const generation = this.#runningGeneration();
    await this.#mutate(generation, async (snapshot) => {
      const operation = snapshot.rooms
        .find((room) => room.id === roomId)
        ?.operations?.find((entry) => entry.id === operationId);
      if (
        !operation ||
        (operation.messageId === null && operation.wakeupId === undefined)
      )
        throw new Error("Cannot acknowledge an uncommitted Room operation");
      operation.acknowledged = true;
    });
  }

  async postRoomMessage(
    roomId: string,
    author: string,
    text: string,
  ): Promise<void> {
    await this.#postRoomMessage(roomId, author, text, "human", null, null);
  }

  async postAgentRoomMessage(
    roomId: string,
    text: string,
    replyToMessageId?: string,
    callingThreadId?: string,
  ): Promise<void> {
    await this.#postRoomMessage(
      roomId,
      "Agent",
      text,
      "agent",
      callingThreadId ?? null,
      null,
      undefined,
      replyToMessageId,
    );
  }

  async #postRoomMessage(
    roomId: string,
    author: string,
    text: string,
    kind: RoomMessage["kind"],
    originThreadId: string | null,
    originTurnId: string | null,
    operationId?: string,
    replyToMessageId?: string,
  ): Promise<RoomSendOperation | undefined> {
    const generation = this.#runningGeneration();
    const normalizedRoomId = required(roomId, "room", MAX_ID_BYTES);
    const normalizedAuthor = required(
      author,
      "author",
      MAX_MESSAGE_AUTHOR_BYTES,
    );
    const normalizedText = required(text, "message", MAX_MESSAGE_TEXT_BYTES);
    const committed = await this.#mutate(generation, async (snapshot) => {
      const room = snapshot.rooms.find(
        (entry) => entry.id === normalizedRoomId,
      );
      if (room === undefined) throw new Error("Room was not found");
      const operation =
        operationId === undefined
          ? undefined
          : room.operations?.find((entry) => entry.id === operationId);
      if (operation?.cancelled === true)
        throw new Error("Room operation was cancelled; no message was sent");
      if (
        operationId !== undefined &&
        (!operation ||
          kind !== "human" ||
          normalizedAuthor !== "You" ||
          operation.kind !== undefined ||
          operation.text !== normalizedText)
      )
        throw new Error(
          "Room operation is missing or bound to a different message",
        );
      if (operation !== undefined && operation.messageId !== null)
        return { wakeups: [], operation: structuredClone(operation) };
      if (operation?.recipientThreadId !== undefined)
        this.#assertAddressedRoomRecipient(
          snapshot,
          room,
          operation.recipientThreadId,
          generation,
        );
      const value = message(
        room.id,
        kind === "agent" && originThreadId !== null
          ? (room.members.find((member) => member.threadId === originThreadId)
              ?.name ?? normalizedAuthor)
          : normalizedAuthor,
        normalizedText,
        kind,
        originThreadId,
        originTurnId,
        this.#now(),
      );
      if (operation?.replyTo)
        value.replyTo = structuredClone(operation.replyTo);
      else if (replyToMessageId !== undefined)
        value.replyTo = roomQuote(room, replyToMessageId);
      room.messages.push(value);
      const wakeups: CommittedWakeup[] = [];
      const mentions = room.members.filter((member) =>
        operation?.recipientThreadId !== undefined
          ? member.threadId === operation.recipientThreadId
          : room.assistant
            ? kind === "human" && member.threadId === room.assistant.threadId
            : mentionMatches(normalizedText, member.name),
      );
      for (const member of mentions) {
        const triggerIds = (generation.wakeupAdmission ? snapshot.triggers : [])
          .filter(
            (trigger) =>
              trigger.active &&
              (room.assistant === undefined ||
                trigger.id === room.assistant.triggerId) &&
              trigger.threadId === member.threadId &&
              trigger.kind === "roomMention" &&
              trigger.room?.roomId === normalizedRoomId &&
              trigger.room.mention.toLocaleLowerCase() ===
                member.name.toLocaleLowerCase(),
          )
          .map((trigger) => trigger.id);
        operation?.mentions.push({
          name: member.name,
          threadId: member.threadId,
          triggerIds,
        });
        for (const triggerId of triggerIds) {
          const commit = this.#commitWakeup(snapshot, triggerId, {
            reason: `Room #${room.name} mention from ${value.author}: ${value.text}`,
            occurrenceKey: `room:${room.id}:${value.id}`,
            sourceRoomId: room.id,
            ...(operation?.recipientThreadId !== undefined
              ? {
                  roomDeliveryMode: "steer" as const,
                  roomRecipientThreadId: operation.recipientThreadId,
                }
              : room.assistant
                ? { roomDeliveryMode: room.assistant.deliveryMode ?? "steer" }
                : {}),
            sourceRoomMessageId: value.id,
            sourceRoomMessageText: [
              value.replyTo
                ? `Reply to ${value.replyTo.author} (${value.replyTo.messageId}): ${value.replyTo.text}`
                : null,
              value.text,
            ]
              .filter((part) => part !== null)
              .join("\n\n"),
            projection: projectRoomContext(room),
          });
          if (commit !== undefined && !("rejected" in commit))
            wakeups.push(commit);
        }
      }
      if (operation) operation.messageId = value.id;
      return {
        wakeups,
        operation:
          operation === undefined ? undefined : structuredClone(operation),
      };
    });
    this.#rescheduleTimers(generation);
    for (const wakeup of committed.wakeups)
      await this.#runCommittedWakeup(generation, wakeup);
    return committed.operation;
  }

  #assertAddressedRoomRecipient(
    snapshot: TriggerSnapshot,
    room: ZenXRoom,
    threadId: string,
    generation: TriggerGeneration,
    expectedTriggerId?: string,
  ): void {
    const member = room.members.find((entry) => entry.threadId === threadId);
    const triggers = snapshot.triggers.filter(
      (trigger) =>
        trigger.active &&
        trigger.threadId === threadId &&
        trigger.kind === "roomMention" &&
        trigger.room?.roomId === room.id &&
        trigger.room.mention.toLocaleLowerCase() ===
          member?.name.toLocaleLowerCase() &&
        (!room.assistant || room.assistant.triggerId === trigger.id),
    );
    if (
      !member ||
      !generation.wakeupAdmission ||
      triggers.length !== 1 ||
      triggers[0]!.program !== undefined ||
      (expectedTriggerId !== undefined && triggers[0]!.id !== expectedTriggerId)
    )
      throw new Error(
        "Board Room delivery requires its exact live member and one enabled direct message recipient",
      );
  }

  async #handleTurnCompleted(
    generation: TriggerGeneration,
    event: ServerNotificationParams["turn/completed"],
    isCurrent: () => boolean = () => this.#isOperational(generation),
  ): Promise<void> {
    // Earlier canonical admission notifications may still be persisting their
    // history projection, especially when restoring an unknown RPC outcome.
    await this.#mutation;
    if (!isCurrent()) return;
    const key = transientTurnKey(event.threadId, event.turn.id);
    const buffered = generation.completedTurnItems.get(key);
    const completedItems = mergeCompletedItems(
      event.turn.items,
      buffered?.threadId === event.threadId ? buffered.items : [],
    );
    const runningEntries = this.#snapshot.history.filter(
      (entry) =>
        entry.threadId === event.threadId &&
        (entry.turnId === event.turn.id ||
          (entry.turnId === null &&
            (entry.delivery === "pending" || entry.delivery === "queued") &&
            completedItems.some(
              (item) =>
                (item.type === "userMessage" || item.type === "hostMessage") &&
                item.clientId === entry.clientUserMessageId,
            ))) &&
        (entry.status === "starting" || entry.status === "running") &&
        generation.activeWakeups.has(entry.clientUserMessageId),
    );
    if (runningEntries.length > 0) {
      for (const running of runningEntries) {
        try {
          await this.#completeTurn(
            generation,
            running.id,
            event,
            completedItems,
            isCurrent,
          );
        } catch (error) {
          if (error instanceof StaleGenerationError) return;
          if (this.#isOperational(generation)) {
            try {
              await this.#failHistory(
                generation,
                running.id,
                `Trigger completion could not be persisted: ${describeError(error)}`,
              );
            } catch (failureError) {
              this.#markStoreUnavailable(generation, running.id, failureError);
            }
          }
        }
      }
      clearTransientTurn(generation, event.threadId, event.turn.id);
    } else {
      this.#bufferEarlyCompletion(generation, event, completedItems);
    }
    if (!isCurrent()) return;
    const watchers = this.#snapshot.triggers
      .filter(
        (trigger) =>
          trigger.active &&
          trigger.kind === "thread" &&
          trigger.watch?.sourceDevice === undefined &&
          trigger.watch?.threadId === event.threadId,
      )
      .map((trigger) => ({
        id: trigger.id,
        revision: trigger.definitionRevision ?? 0,
      }));
    for (const trigger of watchers) {
      await this.#fireThreadCompletion(
        generation,
        trigger.id,
        event.threadId,
        {
          ...event.turn,
          items: completedItems,
        },
        trigger.revision,
      );
    }
  }

  async #fireThreadCompletion(
    generation: TriggerGeneration,
    triggerId: string,
    threadId: string,
    turn: Turn,
    definitionRevision?: number,
  ): Promise<void> {
    if (turn.status === "inProgress") return;
    const eventText = completedItemText(turn.items);
    await this.#fire(generation, triggerId, {
      reason: `Thread ${threadId}: ${turn.status} (Turn ${turn.id})`,
      occurrenceKey: `thread:${threadId}:${turn.id}`,
      sourceThreadId: threadId,
      sourceTurnId: turn.id,
      ...(definitionRevision === undefined
        ? {}
        : { sourceDefinitionRevision: definitionRevision }),
      projection: projectCompletedTurn(threadId, turn),
      ...(eventText === undefined ? {} : { eventText }),
    });
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
          trigger.watch?.sourceDevice === undefined &&
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
            (
              item,
            ): item is Extract<
              ThreadItem,
              { type: "userMessage" | "hostMessage" }
            > => item.type === "userMessage" || item.type === "hostMessage",
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
    if (!this.#isWakeupOperational(generation)) return;
    let committed: WakeupCommitResult;
    try {
      committed = await this.#mutate(generation, async (snapshot) =>
        this.#commitWakeup(snapshot, triggerId, wakeup),
      );
    } catch (error) {
      if (error instanceof StaleGenerationError) return;
      throw error;
    }
    if (committed === undefined || "rejected" in committed) {
      this.#rescheduleTimers(generation);
      return;
    }
    this.#rescheduleTimers(generation);
    await this.#runCommittedWakeup(generation, committed);
  }

  #commitWakeup(
    snapshot: TriggerSnapshot,
    triggerId: string,
    wakeup: WakeupEvent,
  ): WakeupCommitResult {
    const trigger = snapshot.triggers.find(
      (item) => item.id === triggerId && item.active,
    );
    if (trigger === undefined) return undefined;
    if (
      wakeup.sourceSubscriptionId !== undefined &&
      this.#generation?.remoteWatches.get(trigger.id)?.id !==
        wakeup.sourceSubscriptionId
    )
      return undefined;
    if (
      wakeup.sourceThreadId !== undefined &&
      (trigger.kind !== "thread" ||
        trigger.watch?.threadId !== wakeup.sourceThreadId ||
        trigger.watch.sourceDevice !== wakeup.sourceDevice ||
        trigger.watch.sourceWorkspace !== wakeup.sourceWorkspace ||
        (wakeup.sourceDefinitionRevision !== undefined &&
          (trigger.definitionRevision ?? 0) !==
            wakeup.sourceDefinitionRevision))
    )
      return undefined;
    // A timer callback may have queued behind a definition update. Check the
    // committed schedule here, after acquiring the mutation slot.
    if (
      wakeup.scheduledAt !== undefined &&
      (trigger.kind !== "timer" ||
        trigger.timer?.nextRunAt !== wakeup.scheduledAt)
    )
      return undefined;
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
      reason: bounded(wakeup.reason, MAX_REASON_BYTES),
      prompt: bounded(trigger.prompt, MAX_TRIGGER_PROMPT_BYTES),
      clientUserMessageId,
      startedAt: this.#now(),
      completedAt: rejected ? this.#now() : null,
      status: rejected ? "failed" : "starting",
      turnId: null,
      error: rejected
        ? `ZenX Trigger wakeup admission is full at ${String(MAX_WAKEUPS)} nonterminal wakeups; this wakeup was not dispatched.`
        : null,
      sourceThreadId: wakeup.sourceThreadId ?? null,
      ...(wakeup.sourceDevice === undefined
        ? {}
        : { sourceDevice: wakeup.sourceDevice }),
      ...(wakeup.sourceWorkspace === undefined
        ? {}
        : { sourceWorkspace: wakeup.sourceWorkspace }),
      sourceTurnId: wakeup.sourceTurnId ?? null,
      sourceRoomId: wakeup.sourceRoomId ?? null,
      sourceRoomMessageId: wakeup.sourceRoomMessageId ?? null,
      replyRoomId:
        trigger.room?.roomId ??
        snapshot.rooms.find(
          (room) => room.assistant?.heartbeatTriggerId === trigger.id,
        )?.id ??
        null,
      replyAuthor:
        trigger.room?.mention ??
        snapshot.rooms.find(
          (room) => room.assistant?.heartbeatTriggerId === trigger.id,
        )?.members[0]?.name ??
        null,
      programInvocationId: null,
      programOutcome: null,
      programOutcomes: [],
      ...(trigger.program === undefined
        ? { delivery: rejected ? ("failed" as const) : ("pending" as const) }
        : {}),
    };
    snapshot.history.unshift(history);
    // Consume the event before dispatch. A failed/uncertain send is visible in
    // history and never silently retried after restart.
    if (trigger.watch?.once === true) trigger.active = false;
    if (trigger.timer !== undefined) {
      if (trigger.timer.intervalMinutes === null) trigger.active = false;
      else {
        trigger.timer.nextRunAt =
          Math.max(this.#now(), wakeup.scheduledAt ?? this.#now()) +
          trigger.timer.intervalMinutes * 60_000;
      }
    }
    return rejected
      ? { rejected: true }
      : {
          trigger: structuredClone(trigger),
          historyId: history.id,
          clientUserMessageId,
          wakeup: structuredClone(wakeup),
        };
  }

  async #runCommittedWakeup(
    generation: TriggerGeneration,
    committed: CommittedWakeup,
  ): Promise<void> {
    const active: ActiveWakeup = {
      ...(committed.wakeup.bootstrapText === undefined
        ? {}
        : { bootstrap: true }),
      historyId: committed.historyId,
      threadId: committed.trigger.threadId,
      clientUserMessageId: committed.clientUserMessageId,
      trigger: committed.trigger,
      generationId: generation.id,
    };
    generation.activeWakeups.set(active.clientUserMessageId, active);
    await this.#executeWakeup(generation, active, committed.wakeup);
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
        const matched = regex.test(wakeup.eventText ?? "");
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
      const assistantRooms = this.#snapshot.rooms.filter(
        (room) => room.assistant?.threadId === trigger.threadId,
      );
      const assistantRoom = assistantRooms.find(
        (room) =>
          room.assistant?.triggerId === trigger.id ||
          room.assistant?.heartbeatTriggerId === trigger.id,
      );
      const sourceRoom =
        wakeup.sourceRoomId === undefined
          ? undefined
          : this.#snapshot.rooms.find(
              (room) => room.id === wakeup.sourceRoomId,
            );
      // Room posts and independent event Triggers never inherit each other's
      // preference, even when they target the same assistant Thread.
      const deliveryMode =
        wakeup.bootstrapText === undefined
          ? (wakeup.roomDeliveryMode ?? trigger.deliveryMode)
          : "steer";
      if (this.#history(active.historyId).delivery === undefined) {
        await this.#mutate(generation, async (snapshot) => {
          const entry = snapshot.history.find(
            (entry) => entry.id === active.historyId,
          );
          if (entry && !isTerminal(entry.status)) entry.delivery = "pending";
        });
      }
      if (!this.#isOperational(generation)) return;
      if (wakeup.roomRecipientThreadId !== undefined) {
        const currentSourceRoom = this.#snapshot.rooms.find(
          (room) => room.id === wakeup.sourceRoomId,
        );
        if (!currentSourceRoom)
          throw new Error("Board's Room is no longer available");
        this.#assertAddressedRoomRecipient(
          this.#snapshot,
          currentSourceRoom,
          wakeup.roomRecipientThreadId,
          generation,
          trigger.id,
        );
      }
      const result = await this.#manager.request("zen/turn/wake", {
        threadId: trigger.threadId,
        clientId: active.clientUserMessageId,
        source:
          wakeup.bootstrapText !== undefined
            ? "bootstrap"
            : sourceRoom === undefined
              ? "trigger"
              : "room",
        ...(wakeup.bootstrapText === undefined
          ? { sourceId: sourceRoom?.id ?? trigger.id }
          : {}),
        text:
          wakeup.bootstrapText !== undefined
            ? [
                assistantWakeupInput(
                  trigger,
                  this.#history(active.historyId),
                  wakeup.projection,
                  assistantRooms,
                  assistantRoom,
                  undefined,
                  true,
                ),
                "",
                wakeup.bootstrapText,
              ].join("\n")
            : assistantRooms.length > 0
              ? assistantWakeupInput(
                  trigger,
                  this.#history(active.historyId),
                  wakeup.projection,
                  assistantRooms,
                  assistantRoom,
                  wakeup.sourceRoomMessageText,
                )
              : wakeupInput(
                  trigger,
                  this.#history(active.historyId),
                  wakeup.projection,
                  wakeup.sourceRoomMessageText,
                ),
        ...(deliveryMode === "queue" ? { mode: "queue" as const } : {}),
      });
      if (!this.#isOperational(generation)) return;
      if (!("mode" in result) || (result.mode !== "queue" && !result.turnId))
        throw new Error(
          "Host wakeup admission is unconfirmed; inspect the Thread before retrying",
        );
      await this.#projectResult(generation, async (snapshot) => {
        const entry = snapshot.history.find(
          (item) => item.id === active.historyId,
        );
        if (!entry || isTerminal(entry.status)) return;
        if (result.mode === "queue" && entry.turnId === null) {
          // This is only a projection of the canonical queue receipt. The Core
          // owns later admission and no Trigger retry or scheduler is created.
          entry.delivery = "queued";
        } else if (result.turnId) {
          entry.turnId = result.turnId;
          entry.status = "running";
          delete entry.delivery;
        }
      });
      if (result.turnId)
        await this.#consumePendingCompletion(generation, active, result.turnId);
      // Recover only the exact canonical receipt when a bootstrap completion
      // raced admission acknowledgement. Never resend or infer a human input.
      if (
        active.bootstrap &&
        !isTerminal(this.#history(active.historyId).status)
      )
        await this.#recoverWakeups(generation);
    } catch (error) {
      if (error instanceof StaleGenerationError) return;
      if (this.#isOperational(generation)) {
        try {
          await this.#failHistory(
            generation,
            active.historyId,
            describeError(error),
            { preserveCanonicalAdmission: true },
          );
        } catch (failureError) {
          this.#markStoreUnavailable(
            generation,
            active.historyId,
            failureError,
          );
        }
      }
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
    isCurrent: () => boolean = () => this.#isOperational(generation),
  ): Promise<void> {
    const released = await this.#projectResult(generation, async (snapshot) => {
      if (!isCurrent()) return;
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
      delete entry.delivery;
      entry.error =
        bounded(event.turn.error?.message ?? "", MAX_ERROR_BYTES) || null;
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
          room.assistant === undefined &&
          answer?.type === "agentMessage" &&
          answer.text.length > 0 &&
          !room.messages.some(
            (message) =>
              message.kind === "agent" &&
              message.originThreadId === entry.threadId &&
              message.originTurnId === event.turn.id,
          )
        ) {
          room.messages.push(
            message(
              room.id,
              entry.replyAuthor,
              bounded(answer.text, MAX_MESSAGE_TEXT_BYTES),
              "agent",
              entry.threadId,
              event.turn.id,
              this.#now(),
            ),
          );
        }
      }
      return true;
    });
    if (released) this.#releaseActiveWakeup(generation, historyId);
  }

  async #recordProgramOutcome(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    outcome: TriggerProgramOutcome,
  ): Promise<void> {
    await this.#projectResult(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === active.historyId,
      );
      if (entry === undefined || isTerminal(entry.status)) return;
      entry.programInvocationId = null;
      entry.programOutcome = outcome;
      entry.programOutcomes = appendProgramOutcome(
        entry.programOutcomes,
        outcome,
      );
    });
  }

  async #recordProgramInvocation(
    generation: TriggerGeneration,
    active: ActiveWakeup,
    invocationId: string,
  ): Promise<void> {
    await this.#projectResult(generation, async (snapshot) => {
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
    const released = await this.#projectResult(generation, async (snapshot) => {
      const entry = snapshot.history.find(
        (candidate) => candidate.id === active.historyId,
      );
      if (entry === undefined || isTerminal(entry.status)) return;
      entry.status = status;
      entry.completedAt = this.#now();
      entry.error = error === null ? null : bounded(error, MAX_ERROR_BYTES);
      entry.programInvocationId = null;
      entry.programOutcome = outcome;
      entry.programOutcomes = appendProgramOutcome(
        entry.programOutcomes,
        outcome,
      );
      return true;
    });
    if (released) this.#releaseActiveWakeup(generation, active.historyId);
  }

  async #failHistory(
    generation: TriggerGeneration,
    historyId: string,
    error: string,
    options: {
      confirmedDeliveryFailure?: boolean;
      preserveCanonicalAdmission?: boolean;
      isCurrent?: () => boolean;
    } = {},
  ): Promise<void> {
    const released = await this.#projectResult(generation, async (snapshot) => {
      if (options.isCurrent && !options.isCurrent()) return;
      const entry = snapshot.history.find(
        (candidate) => candidate.id === historyId,
      );
      if (
        entry === undefined ||
        (isTerminal(entry.status) &&
          !(options.confirmedDeliveryFailure && entry.delivery === "unknown"))
      )
        return;
      if (
        options.preserveCanonicalAdmission &&
        (entry.delivery === "queued" || entry.turnId !== null)
      ) {
        if (entry.delivery === "queued")
          entry.error = bounded(error, MAX_ERROR_BYTES);
        return;
      }
      entry.status = "failed";
      if (options.confirmedDeliveryFailure) entry.delivery = "failed";
      else if (entry.delivery === "pending") entry.delivery = "unknown";
      else if (entry.delivery === "queued") entry.delivery = "failed";
      entry.completedAt = this.#now();
      entry.error = bounded(error, MAX_ERROR_BYTES);
      return true;
    });
    if (released) this.#releaseActiveWakeup(generation, historyId);
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

  #disposeRemoteWatches(generation: TriggerGeneration): void {
    const watches = [...generation.remoteWatches.values()];
    generation.remoteWatches.clear();
    for (const watch of watches) disposeRemoteWatch(watch);
  }

  #syncRemoteWatches(
    generation: TriggerGeneration,
    includeCurrentTerminalTriggerId?: string,
  ): void {
    if (!this.#isWakeupOperational(generation)) return;
    const definitions = new Map(
      this.#snapshot.triggers
        .filter(
          (trigger) =>
            trigger.active &&
            trigger.kind === "thread" &&
            trigger.watch?.sourceDevice !== undefined,
        )
        .map((trigger) => [trigger.id, trigger] as const),
    );
    for (const [id, registration] of generation.remoteWatches) {
      const trigger = definitions.get(id);
      if (trigger && remoteWatchDefinition(trigger) === registration.definition)
        continue;
      // Remove the callback fence before aborting a possibly synchronous port.
      generation.remoteWatches.delete(id);
      disposeRemoteWatch(registration);
    }
    for (const trigger of definitions.values()) {
      if (generation.remoteWatches.has(trigger.id)) continue;
      const watch = trigger.watch!;
      const registration: RemoteWatch = {
        id: randomUUID(),
        definition: remoteWatchDefinition(trigger),
        controller: new AbortController(),
        ready: Promise.resolve(),
      };
      generation.remoteWatches.set(trigger.id, registration);
      const current = () =>
        this.#isWakeupOperational(generation) &&
        generation.remoteWatches.get(trigger.id) === registration &&
        !registration.controller.signal.aborted;
      const sourceError = (error: unknown) => {
        if (!current()) return;
        registration.error = bounded(
          `Source device ${watch.sourceDevice}, Thread ${watch.threadId}: ${describeError(error)}`,
          MAX_ERROR_BYTES,
        );
        this.#notify();
      };
      // Publish the registration identity before invoking the port: canonical
      // recovery may deliver a completion synchronously before it returns.
      registration.ready = (async () => {
        try {
          if (!this.#manager.subscribeRemoteThread)
            throw new Error("Remote Thread observation is unavailable");
          const dispose = await this.#manager.subscribeRemoteThread(
            watch.sourceDevice!,
            watch.sourceWorkspace,
            watch.threadId,
            {
              includeCurrentTerminal:
                trigger.id === includeCurrentTerminalTriggerId,
              onReady: () => {
                if (!current() || registration.error === undefined) return;
                delete registration.error;
                this.#notify();
              },
              onError: sourceError,
              onTurn: (turn) => {
                if (current() && turn.threadId !== watch.threadId) {
                  sourceError(
                    new Error(
                      "Remote source Thread identity changed; completion was ignored",
                    ),
                  );
                  return;
                }
                if (
                  !current() ||
                  turn.threadId !== watch.threadId ||
                  !["completed", "failed", "interrupted"].includes(turn.status)
                )
                  return;
                delete registration.error;
                this.#notify();
                void this.#fire(generation, trigger.id, {
                  reason: `Device ${watch.sourceDevice}, Thread ${turn.threadId}: ${turn.status} (Turn ${turn.turnId})`,
                  occurrenceKey: `remote-thread:${JSON.stringify([watch.sourceDevice, watch.sourceWorkspace ?? null, turn.threadId, turn.turnId])}`,
                  sourceDevice: watch.sourceDevice,
                  ...(watch.sourceWorkspace === undefined
                    ? {}
                    : { sourceWorkspace: watch.sourceWorkspace }),
                  sourceThreadId: turn.threadId,
                  sourceTurnId: turn.turnId,
                  sourceDefinitionRevision: trigger.definitionRevision ?? 0,
                  sourceSubscriptionId: registration.id,
                  projection: [
                    `Source device: ${watch.sourceDevice}`,
                    ...(watch.sourceWorkspace === undefined
                      ? []
                      : [`Source workspace: ${watch.sourceWorkspace}`]),
                    `Source Thread: ${turn.threadId}`,
                    `Source Turn: ${turn.turnId}`,
                    `Status: ${turn.status}`,
                    "Read the exact source Turn with zenx_threads_read using the source device, workspace, Thread and Turn IDs before reporting its result.",
                  ].join("\n"),
                }).catch(sourceError);
              },
            },
            registration.controller.signal,
          );
          if (current()) registration.dispose = dispose;
          else disposeRemoteWatch({ ...registration, dispose });
        } catch (error) {
          sourceError(error);
        }
      })();
    }
  }

  #rescheduleTimers(generation: TriggerGeneration): void {
    if (!this.#isWakeupOperational(generation)) return;
    const schedules = new Map<string, number>();
    for (const trigger of this.#snapshot.triggers) {
      if (trigger.active && trigger.timer !== undefined)
        schedules.set(trigger.id, trigger.timer.nextRunAt);
    }
    for (const [triggerId, timer] of generation.timers) {
      if (schedules.get(triggerId) === timer.scheduledAt) continue;
      this.#cancelScheduled(timer.handle);
      generation.timers.delete(triggerId);
    }
    for (const [triggerId, scheduledAt] of schedules) {
      if (!generation.timers.has(triggerId))
        this.#scheduleTimer(generation, triggerId, scheduledAt);
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
    const timer = {
      scheduledAt,
      handle: this.#schedule(() => {
        if (
          !this.#isWakeupOperational(generation) ||
          generation.timers.get(triggerId) !== timer
        )
          return;
        if (this.#now() < scheduledAt) {
          this.#scheduleTimer(generation, triggerId, scheduledAt);
          return;
        }
        // Retain this registration until the occurrence commits, so an
        // unrelated mutation cannot register a second callback while it waits.
        void this.#fire(generation, triggerId, {
          reason: `Timer reached ${new Date(scheduledAt).toISOString()}`,
          occurrenceKey: `timer:${scheduledAt}`,
          scheduledAt,
        }).catch((error: unknown) => {
          if (generation.timers.get(triggerId) === timer)
            generation.timers.delete(triggerId);
          if (this.#isWakeupOperational(generation))
            console.warn(`Could not fire Timer: ${describeError(error)}`);
        });
      }, delay),
    };
    generation.timers.set(triggerId, timer);
  }

  #projectResult<T>(
    generation: TriggerGeneration,
    projection: (snapshot: TriggerSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.#mutate(
      generation,
      projection,
      false,
      undefined,
      this.#store,
      true,
    );
  }

  #releaseStorageWaiters(generation: TriggerGeneration): void {
    for (const resolve of generation.storageWaiters) resolve();
    generation.storageWaiters.clear();
  }

  async #waitForStoragePublication(
    generation: TriggerGeneration,
  ): Promise<void> {
    for (;;) {
      this.#assertMutationGeneration(generation);
      if (generation.storeUnavailable)
        throw new Error("ZenX Trigger persistence is unavailable");
      if (
        generation.storageGateOpen !== false &&
        (this.#wakeupGate?.isOpen() ?? true)
      )
        return;
      await new Promise<void>((resolve) => {
        generation.storageWaiters.add(resolve);
      });
    }
  }

  async #mutate<T>(
    generation: TriggerGeneration,
    operation: (snapshot: TriggerSnapshot) => Promise<T>,
    allowRetiring = false,
    includeCurrentTerminalTriggerId?: string,
    store: ZenXTriggerStorePort = this.#store,
    reapplyProjectionAfterFence = false,
  ): Promise<T> {
    // Wait outside the slot so runtime rollback/retirement can still finish.
    // Only explicitly pure result projections may be reapplied after a fence;
    // arbitrary mutation callbacks (which may update closure state) are not.
    for (;;) {
      if (!allowRetiring) await this.#waitForStoragePublication(generation);
      this.#assertMutationGeneration(generation, allowRetiring);
      const previous = this.#mutation;
      let release!: () => void;
      this.#mutation = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        this.#assertMutationGeneration(generation, allowRetiring);
        if (
          !allowRetiring &&
          (generation.storageGateOpen === false ||
            !(this.#wakeupGate?.isOpen() ?? true))
        )
          continue;
        const snapshot = structuredClone(this.#snapshot);
        const result = await operation(snapshot);
        this.#assertMutationGeneration(generation, allowRetiring);
        retainSnapshot(snapshot);
        try {
          await store.write(snapshot);
        } catch (error) {
          if (
            reapplyProjectionAfterFence &&
            !allowRetiring &&
            this.#wakeupGate?.isBlockedError?.(error)
          )
            continue;
          throw error;
        }
        this.#assertMutationGeneration(generation, allowRetiring);
        this.#snapshot = snapshot;
        this.#syncRemoteWatches(generation, includeCurrentTerminalTriggerId);
        this.#notify();
        return result;
      } finally {
        release();
      }
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
      !generation.storeUnavailable &&
      this.#generation === generation
    );
  }

  #isWakeupOperational(generation: TriggerGeneration): boolean {
    return (
      generation.wakeupAdmission &&
      generation.storageGateOpen !== false &&
      (this.#wakeupGate?.isOpen() ?? true) &&
      this.#isOperational(generation)
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
      error: bounded(error ?? "", MAX_ERROR_BYTES) || null,
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.snapshot());
      } catch (error) {
        console.warn(
          `ZenX Trigger change listener failed after the mutation committed: ${bounded(
            describeError(error),
            MAX_ERROR_BYTES,
          )}`,
        );
      }
    }
  }

  #hostSource(entry: TriggerHistoryEntry): {
    source: "bootstrap" | "trigger" | "room";
    sourceId?: string;
  } {
    // The canonical Host receipt owns provenance. Existing history only
    // correlates the origin: a bootstrap targets a Room without originating
    // from a Room message; ordinary Room sends always record both identities.
    // Never infer this from the bounded, evictable Room operation log.
    const bootstrap =
      entry.sourceRoomId !== null && entry.sourceRoomMessageId === null;
    return bootstrap
      ? { source: "bootstrap" }
      : {
          source: entry.sourceRoomId === null ? "trigger" : "room",
          sourceId: entry.sourceRoomId ?? entry.triggerId,
        };
  }

  #observeHostWakeup(
    generation: TriggerGeneration,
    item: {
      threadId: string;
      clientId: string;
      source?: "bootstrap" | "trigger" | "room";
      sourceId?: string;
    },
  ): ActiveWakeup | undefined {
    const entry = this.#snapshot.history.find(
      (entry) =>
        entry.threadId === item.threadId &&
        entry.clientUserMessageId === item.clientId,
    );
    if (
      !entry ||
      entry.delivery === "failed" ||
      (isTerminal(entry.status) && entry.delivery !== "unknown")
    )
      return undefined;
    // Host admission/queue records carry provenance; cancellation carries
    // only the already-known queue identity. A reused clientId from another
    // Host source must never acquire this history's reply route.
    if (
      item.source !== undefined &&
      (item.source !== this.#hostSource(entry).source ||
        item.sourceId !== this.#hostSource(entry).sourceId)
    )
      return undefined;
    const existing = generation.activeWakeups.get(item.clientId);
    if (existing) return existing;
    // Recover only observation of this exact canonical identity, including
    // after a service restart or a lost RPC reply. Never dispatch from history.
    const active: ActiveWakeup = {
      ...(item.source === "bootstrap" ? { bootstrap: true as const } : {}),
      historyId: entry.id,
      threadId: entry.threadId,
      clientUserMessageId: item.clientId,
      generationId: generation.id,
      trigger: this.#snapshot.triggers.find(
        (trigger) => trigger.id === entry.triggerId,
      ) ?? {
        id: entry.triggerId,
        threadId: entry.threadId,
        kind: entry.kind,
        label: "",
        prompt: entry.prompt,
        createdAt: entry.startedAt,
        active: false,
      },
    };
    generation.activeWakeups.set(item.clientId, active);
    return active;
  }

  #releaseActiveWakeup(generation: TriggerGeneration, historyId: string): void {
    for (const [clientUserMessageId, active] of generation.activeWakeups) {
      if (active.historyId === historyId)
        generation.activeWakeups.delete(clientUserMessageId);
    }
  }

  #markStoreUnavailable(
    generation: TriggerGeneration,
    historyId: string,
    error: unknown,
  ): void {
    generation.storeUnavailable = true;
    this.#disposeRemoteWatches(generation);
    this.#releaseActiveWakeup(generation, historyId);
    console.warn(
      `ZenX Trigger persistence is unavailable; no new wakeups will dispatch: ${bounded(
        describeError(error),
        MAX_ERROR_BYTES,
      )}`,
    );
  }
}

class StaleGenerationError extends Error {
  constructor() {
    super("ZenX Trigger service lifecycle changed");
  }
}

function newGeneration(wakeupAdmission = true): TriggerGeneration {
  return {
    id: randomUUID(),
    active: true,
    retiring: false,
    storeUnavailable: false,
    wakeupAdmission,
    storageWaiters: new Set(),
    recoveringThreads: new Map(),
    timers: new Map(),
    remoteWatches: new Map(),
    completedTurnItems: new Map(),
    pendingCompletedTurns: new Map(),
    activeWakeups: new Map(),
    programControllers: new Map(),
    disposeNotifications: undefined,
  };
}

function isRemoteWatchInput(input: CreateTriggerInput): boolean {
  return (
    input.kind === "thread" &&
    input.sourceDevice !== undefined &&
    input.sourceDevice.trim() !== "local"
  );
}

function remoteWatchDefinition(trigger: ZenXTrigger): string {
  return JSON.stringify([
    trigger.id,
    trigger.definitionRevision ?? 0,
    trigger.threadId,
    trigger.watch,
    trigger.prompt,
    trigger.program,
  ]);
}

function withoutSourceError(trigger: ZenXTrigger): ZenXTrigger {
  const copy = { ...trigger };
  delete copy.sourceError;
  return copy;
}

function disposeRemoteWatch(watch: RemoteWatch): void {
  watch.controller.abort();
  try {
    watch.dispose?.();
  } catch (error) {
    console.warn(
      `Could not close remote Trigger observation: ${bounded(describeError(error), MAX_ERROR_BYTES)}`,
    );
  }
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
    threadId: required(input.threadId, "thread", MAX_ID_BYTES),
    kind: input.kind,
    label: required(input.label, "label", MAX_TRIGGER_LABEL_BYTES),
    prompt: required(input.prompt, "prompt", MAX_TRIGGER_PROMPT_BYTES),
    createdAt,
    active,
    ...(input.deliveryMode === undefined
      ? {}
      : { deliveryMode: validateDeliveryMode(input.deliveryMode) }),
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
    if (input.once !== undefined && typeof input.once !== "boolean")
      throw new Error("once must be a boolean");
    const sourceDevice =
      input.sourceDevice === undefined
        ? undefined
        : required(input.sourceDevice, "source device", MAX_ID_BYTES);
    if (
      input.sourceWorkspace !== undefined &&
      (sourceDevice === undefined || sourceDevice === "local")
    )
      throw new Error("sourceWorkspace requires a remote sourceDevice");
    return {
      ...common,
      kind: "thread",
      watch: {
        threadId: required(
          input.watchedThreadId,
          "watched thread",
          MAX_ID_BYTES,
        ),
        event: "turn_completed",
        ...(input.once === undefined ? {} : { once: input.once }),
        ...(sourceDevice === undefined || sourceDevice === "local"
          ? {}
          : { sourceDevice }),
        ...(input.sourceWorkspace === undefined
          ? {}
          : {
              sourceWorkspace: required(
                input.sourceWorkspace,
                "source workspace",
                MAX_ID_BYTES,
              ),
            }),
      },
    };
  }
  if (input.kind === "roomMention") {
    return {
      ...common,
      kind: "roomMention",
      room: {
        roomId: required(input.roomId, "room", MAX_ID_BYTES),
        mention: required(input.mention, "mention", MAX_MEMBER_NAME_BYTES),
      },
    };
  }
  return {
    ...common,
    kind: "signal",
    signal: { name: required(input.signalName, "signal name", MAX_ID_BYTES) },
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
    required(spec.command, `${stage} command`, MAX_PROGRAM_COMMAND_BYTES);
    if ((spec.args?.length ?? 0) > MAX_PROGRAM_ARGUMENTS)
      throw new Error(`${stage} has too many arguments`);
    if (spec.args?.some((arg) => !withinBytes(arg, MAX_PROGRAM_ARGUMENT_BYTES)))
      throw new Error(`${stage} argument is too long`);
    if (
      spec.cwd !== undefined &&
      !withinBytes(
        required(spec.cwd, `${stage} cwd`, MAX_PROGRAM_CWD_BYTES),
        MAX_PROGRAM_CWD_BYTES,
      )
    )
      throw new Error(`${stage} cwd is too long`);
    if (
      spec.timeoutMs !== undefined &&
      (!Number.isFinite(spec.timeoutMs) ||
        spec.timeoutMs <= 0 ||
        spec.timeoutMs > MAX_PROGRAM_TIMEOUT_MS)
    )
      throw new Error(
        `${stage} timeoutMs must be between 1 and ${String(MAX_PROGRAM_TIMEOUT_MS)}`,
      );
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
      (Object.keys(spec.env).length > MAX_PROGRAM_ENV_ENTRIES ||
        Object.entries(spec.env).some(
          ([key, value]) =>
            key.length === 0 ||
            !withinBytes(key, MAX_PROGRAM_ENV_KEY_BYTES) ||
            !withinBytes(value, MAX_PROGRAM_ENV_VALUE_BYTES),
        ) ||
        Object.entries(spec.env).reduce(
          (total, [key, value]) => total + utf8Bytes(key) + utf8Bytes(value),
          0,
        ) > MAX_PROGRAM_ENV_BYTES)
    )
      throw new Error(`${stage} env is invalid`);
  }
  if (program.match !== undefined) {
    if (
      program.match.field !== "completedItemText" ||
      !withinBytes(
        required(
          program.match.regex,
          "match regex",
          MAX_PROGRAM_MATCH_REGEX_BYTES,
        ),
        MAX_PROGRAM_MATCH_REGEX_BYTES,
      ) ||
      (program.match.flags !== undefined &&
        !withinBytes(program.match.flags, MAX_PROGRAM_FLAGS_BYTES))
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
      device: wakeup.sourceDevice ?? "local",
      workspace: wakeup.sourceWorkspace ?? null,
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

function required(
  value: string,
  label: string,
  maximum = MAX_ID_BYTES,
): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Trigger ${label} is required`);
  const normalized = value.trim();
  if (!withinBytes(normalized, maximum))
    throw new Error(
      `Trigger ${label} exceeds its ${String(maximum)} byte bound`,
    );
  return normalized;
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
  if (members.length > MAX_ROOM_MEMBERS)
    throw new Error(
      `Room cannot have more than ${String(MAX_ROOM_MEMBERS)} members`,
    );
  const normalized = members.map((member) => ({
    name: required(member.name, "member name", MAX_MEMBER_NAME_BYTES),
    threadId: required(member.threadId, "member thread", MAX_ID_BYTES),
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

function retainSnapshot(snapshot: TriggerSnapshot): void {
  if (snapshot.triggers.length > MAX_TRIGGER_COUNT)
    throw new Error(`ZenX Trigger limit is ${String(MAX_TRIGGER_COUNT)}`);
  if (snapshot.rooms.length > MAX_ROOM_COUNT)
    throw new Error(`ZenX Room limit is ${String(MAX_ROOM_COUNT)}`);
  snapshot.history = retainHistory(snapshot.history);
  for (const room of snapshot.rooms) {
    if (room.members.length > MAX_ROOM_MEMBERS)
      throw new Error(
        `Room cannot have more than ${String(MAX_ROOM_MEMBERS)} members`,
      );
    if ((room.operations?.length ?? 0) > MAX_ROOM_OPERATIONS)
      throw new Error("Unresolved Room operation limit reached");
    room.messages = room.messages.slice(-MAX_ROOM_MESSAGES);
  }
}

function appendProgramOutcome(
  outcomes: TriggerProgramOutcome[] | undefined,
  outcome: TriggerProgramOutcome,
): TriggerProgramOutcome[] {
  return [...(outcomes ?? []), outcome].slice(-MAX_PROGRAM_OUTCOMES);
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
  completeRoomMessage?: string,
): string {
  const source = [
    history.sourceDevice === undefined
      ? null
      : `Source device: ${history.sourceDevice}`,
    history.sourceWorkspace === undefined
      ? null
      : `Source workspace: ${history.sourceWorkspace}`,
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
    ...(completeRoomMessage === undefined
      ? []
      : [
          "",
          "Current Room message (complete; preserve the author and kind shown in source context):",
          completeRoomMessage,
        ]),
    ...(projection === undefined
      ? []
      : [
          "",
          "Bounded source context (read-only projection):",
          bounded(projection, 6_000),
        ]),
  ].join("\n");
}

function newAssistantHeartbeat(room: ZenXRoom, now: number): ZenXTrigger {
  return triggerFromInput(
    {
      kind: "timer",
      threadId: room.assistant!.threadId,
      label: "PAW heartbeat",
      prompt: pawHeartbeatPrompt(room.id),
      runAt: now + PAW_HEARTBEAT_INTERVAL_MINUTES * 60_000,
      intervalMinutes: PAW_HEARTBEAT_INTERVAL_MINUTES,
    },
    randomUUID(),
    now,
    true,
    now,
  );
}

function assistantWakeupInput(
  trigger: ZenXTrigger,
  history: TriggerHistoryEntry,
  projection: string | undefined,
  rooms: ZenXRoom[],
  sourceRoom: ZenXRoom | undefined,
  sourceMessageText: string | undefined,
  bootstrap = false,
): string {
  const input = wakeupInput(trigger, history, projection, sourceMessageText);
  const preset =
    trigger.prompt === ALWAYS_ON_ASSISTANT_PROMPT
      ? []
      : ["PAW context:", ALWAYS_ON_ASSISTANT_PROMPT];
  if (sourceRoom) {
    return [
      input,
      "",
      ...preset,
      `Reply Room ID: ${sourceRoom.id}`,
      `Current PAW display name: ${JSON.stringify(sourceRoom.name)}`,
      ...(sourceMessageText !== undefined ||
      bootstrap ||
      history.sourceRoomMessageId === null
        ? []
        : [
            "The source Room message is no longer retained; recover its context before acting.",
          ]),
    ].join("\n");
  }
  return [
    input,
    "",
    ...preset,
    `Associated assistant Room IDs: ${rooms.map((room) => room.id).join(", ")}`,
    "This is an event continuation. Honor the registered trigger prompt and its explicit destination. Associated Rooms provide context; do not select a Room implicitly or treat this event as a new user message.",
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
      turn.error === null
        ? null
        : `Error: ${bounded(turn.error.message, 1_000)}`,
      userInputs.length === 0
        ? null
        : `User input:\n${userInputs.join("\n\n")}`,
      commands.length === 0
        ? null
        : `Command/result summary:\n${commands.join("\n\n")}`,
      conclusion?.type === "agentMessage"
        ? `${turn.status === "completed" ? "Agent conclusion" : "Agent output (turn did not complete successfully)"}:\n${bounded(conclusion.text, 1_800)}`
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
    return `${entry.author} (${entry.kind})${origin}${entry.replyTo ? ` [reply to ${entry.replyTo.author}: ${entry.replyTo.text}]` : ""}: ${bounded(entry.text, 700)}`;
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

function completedItemText(items: readonly ThreadItem[]): string | undefined {
  const answer = [...items]
    .reverse()
    .find(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage",
    );
  return answer?.text;
}

function bounded(value: string, limit: number): string {
  if (utf8Bytes(value) <= limit) return value;
  if (limit <= 0) return "";
  const suffix = "\n…[truncated by ZenX]";
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes > limit) return prefixByBytes(suffix, limit);
  return `${prefixByBytes(value, limit - suffixBytes)}${suffix}`;
}

function prefixByBytes(value: string, limit: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > limit) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ROOM_REACTION_EMOJI = [
  "👍",
  "❤️",
  "🎉",
  "👀",
  "✅",
  "🤔",
] as const satisfies readonly string[];
function roomQuote(room: ZenXRoom, messageId: string) {
  const source = room.messages.find((entry) => entry.id === messageId);
  if (!source) throw new Error("Reply target is not retained in this Room");
  return {
    messageId: source.id,
    author: source.author,
    text: bounded(source.text, 1000),
  };
}

function validateDeliveryMode(value: unknown): WakeupDeliveryMode {
  if (value !== "steer" && value !== "queue")
    throw new Error("deliveryMode must be steer or queue");
  return value;
}

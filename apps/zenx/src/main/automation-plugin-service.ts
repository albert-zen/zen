import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  listThreadCandidates,
  resolveThreadTarget,
  type ThreadTargetPort,
} from "./thread-target.js";

import {
  ZENX_ROOMS_CAPABILITY_ID,
  ZENX_TRIGGERS_CAPABILITY_ID,
  type ZenXAutomationControlPort,
} from "./capabilities/automation-control-package.js";
import {
  JsonPluginStorage,
  type PluginStorageValue,
  type ZenXPluginHostSdkV1,
} from "./plugin-host-sdk.js";
import {
  ZenXTriggerService,
  projectCompletedTurn,
  type ZenXTriggerAppServerPort,
  type ZenXTriggerStorePort,
  type ZenXTriggerTitlePort,
} from "./trigger-service.js";
import { canonicalTriggerSnapshot, ZenXTriggerStore } from "./trigger-store.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerSnapshot,
  UpdateTriggerInput,
} from "./trigger-types.js";

export async function createBundledAutomationPluginService(options: {
  userDataDirectory: string;
  appServer: ZenXTriggerAppServerPort;
  titles?: ZenXTriggerTitlePort;
  threadTargets?: ThreadTargetPort;
}): Promise<ZenXBundledAutomationPluginService> {
  let legacy: TriggerSnapshot;
  try {
    legacy = await new ZenXTriggerStore(
      path.join(options.userDataDirectory, "trigger-registry.json"),
    ).read();
  } catch (error) {
    // Rooms and Triggers are optional capabilities. Preserve the corrupt
    // legacy file for repair, but do not prevent the core host from starting.
    console.error(
      `ZenX legacy automation state is unavailable; starting with empty optional state: ${describeError(error)}`,
    );
    legacy = { triggers: [], history: [], rooms: [] };
  }
  const storageRoot = path.join(options.userDataDirectory, "plugin-data");
  await initializeOptionalStorage(
    {
      pluginId: ZENX_TRIGGERS_CAPABILITY_ID,
      root: storageRoot,
      version: 1,
      initialValue: {
        triggers: legacy.triggers,
        history: legacy.history,
      },
    },
    ZENX_TRIGGERS_CAPABILITY_ID,
  );
  await initializeOptionalStorage(
    {
      pluginId: ZENX_ROOMS_CAPABILITY_ID,
      root: storageRoot,
      version: 1,
      initialValue: { rooms: legacy.rooms },
    },
    ZENX_ROOMS_CAPABILITY_ID,
  );
  const active = new Set<string>();
  return new ZenXBundledAutomationPluginService(
    options.appServer,
    new PluginAutomationStore(storageRoot, active),
    active,
    options.titles,
    options.threadTargets,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initializeOptionalStorage(
  options: Parameters<typeof JsonPluginStorage.open>[0],
  pluginId: string,
): Promise<void> {
  try {
    await JsonPluginStorage.open(options);
  } catch (error) {
    // Keep a corrupt optional store in place for explicit repair. The
    // capability runtime will remain unavailable, but ZenX itself can start.
    console.error(
      `ZenX optional plugin storage is unavailable for ${pluginId}: ${describeError(error)}`,
    );
  }
}

class PluginAutomationStore implements ZenXTriggerStorePort {
  readonly #root: string;
  readonly #active: ReadonlySet<string>;

  constructor(root: string, active: ReadonlySet<string>) {
    this.#root = root;
    this.#active = active;
  }

  async read(): Promise<TriggerSnapshot> {
    const [triggerData, roomData] = await Promise.all([
      readPluginValue(this.#root, ZENX_TRIGGERS_CAPABILITY_ID, {
        triggers: [],
        history: [],
      }),
      readPluginValue(this.#root, ZENX_ROOMS_CAPABILITY_ID, { rooms: [] }),
    ]);
    return canonicalTriggerSnapshot({
      triggers: triggerData["triggers"],
      history: triggerData["history"],
      rooms: roomData["rooms"],
    });
  }

  async write(snapshot: TriggerSnapshot): Promise<void> {
    if (this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID)) {
      const triggers = await JsonPluginStorage.open({
        pluginId: ZENX_TRIGGERS_CAPABILITY_ID,
        root: this.#root,
        version: 1,
        initialValue: { triggers: [], history: [] },
      });
      await triggers.set({
        triggers: snapshot.triggers,
        history: snapshot.history,
      });
    }
    if (this.#active.has(ZENX_ROOMS_CAPABILITY_ID)) {
      const rooms = await JsonPluginStorage.open({
        pluginId: ZENX_ROOMS_CAPABILITY_ID,
        root: this.#root,
        version: 1,
        initialValue: { rooms: [] },
      });
      await rooms.set({ rooms: snapshot.rooms });
    }
  }
}

async function readPluginValue(
  root: string,
  pluginId: string,
  fallback: PluginStorageValue,
): Promise<PluginStorageValue> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(root, pluginId, "storage.json"), "utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { value?: unknown }).value !== "object" ||
      (parsed as { value?: unknown }).value === null ||
      Array.isArray((parsed as { value?: unknown }).value)
    ) {
      throw new Error(`Plugin storage document is invalid: ${pluginId}`);
    }
    return structuredClone((parsed as { value: PluginStorageValue }).value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return structuredClone(fallback);
    throw error;
  }
}

export class ZenXBundledAutomationPluginService implements ZenXAutomationControlPort {
  readonly #service: ZenXTriggerService;
  readonly #active: Set<string>;
  readonly #targets: ThreadTargetPort | undefined;
  readonly #appServer: ZenXTriggerAppServerPort;
  #lifecycle: Promise<void> = Promise.resolve();

  constructor(
    appServer: ZenXTriggerAppServerPort,
    store: ZenXTriggerStorePort,
    active: Set<string>,
    titles?: ZenXTriggerTitlePort,
    targets?: ThreadTargetPort,
  ) {
    this.#active = active;
    this.#appServer = appServer;
    this.#targets = targets;
    this.#service = new ZenXTriggerService(appServer, store, { titles });
  }

  async startPlugin(
    pluginId: string,
    _sdk: ZenXPluginHostSdkV1,
  ): Promise<void> {
    await this.#serialize(async () => {
      if (this.#active.has(pluginId)) return;
      const first = this.#active.size === 0;
      if (first) {
        this.#active.add(pluginId);
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
        } catch (error) {
          this.#active.delete(pluginId);
          throw error;
        }
      } else {
        await this.#service.stop();
        this.#active.add(pluginId);
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
        } catch (error) {
          this.#active.delete(pluginId);
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
          throw error;
        }
      }
    });
  }

  async stopPlugin(pluginId: string): Promise<void> {
    await this.#serialize(async () => {
      if (!this.#active.has(pluginId)) return;
      if (this.#active.size === 1) {
        await this.#service.stop();
        this.#active.delete(pluginId);
      } else {
        this.#active.delete(pluginId);
      }
      if (this.#active.size > 0 && pluginId === ZENX_TRIGGERS_CAPABILITY_ID)
        this.#service.suspendWakeups();
    });
  }

  snapshot(): TriggerSnapshot {
    return this.#service.snapshot();
  }

  async create(input: CreateTriggerInput) {
    return await this.#service.create(await this.#resolveInput(input));
  }
  async update(input: UpdateTriggerInput) {
    return await this.#service.update({
      ...(await this.#resolveInput(input)),
      id: input.id,
    });
  }
  async threads() {
    if (this.#targets === undefined)
      throw new Error("Thread discovery is unavailable");
    return await listThreadCandidates(this.#targets);
  }
  async result(historyId: string) {
    const entry = this.#service
      .snapshot()
      .history.find((item) => item.id === historyId);
    if (entry?.sourceThreadId == null || entry.sourceTurnId == null)
      throw new Error(
        "Source result was not found in retained notification history",
      );
    if (this.#appServer.readThread === undefined)
      throw new Error("Reading Thread results is unavailable");
    const read = await this.#appServer.readThread(entry.sourceThreadId);
    const turn = read.thread.turns.find(
      (item) => item.id === entry.sourceTurnId,
    );
    if (turn === undefined) throw new Error("Source Turn is unavailable");
    return {
      threadId: entry.sourceThreadId,
      turnId: turn.id,
      status: turn.status,
      preview: projectCompletedTurn(entry.sourceThreadId, turn),
    };
  }
  async #resolveInput(input: CreateTriggerInput): Promise<CreateTriggerInput> {
    if (this.#targets === undefined) return input;
    const resolve = async (target: string) => {
      const result = await resolveThreadTarget(this.#targets!, { target });
      if (result.status !== "resolved")
        throw new Error(
          `Thread target ${JSON.stringify(target)} is ${result.status}: ${JSON.stringify(result.candidates)}`,
        );
      return result.threadId;
    };
    const threadId = await resolve(input.threadId);
    return input.kind === "thread"
      ? {
          ...input,
          threadId,
          watchedThreadId: await resolve(input.watchedThreadId),
        }
      : { ...input, threadId };
  }
  async cancel(triggerId: string): Promise<void> {
    await this.#service.cancel(triggerId);
  }
  async delete(triggerId: string): Promise<void> {
    await this.#service.delete(triggerId);
  }
  async signal(name: string, detail: string): Promise<void> {
    await this.#service.signal(name, detail);
  }
  async createRoom(input: CreateRoomInput) {
    return await this.#service.createRoom(input);
  }
  async renameRoom(roomId: string, name: string): Promise<void> {
    await this.#service.renameRoom(roomId, name);
  }
  async deleteRoom(roomId: string): Promise<void> {
    await this.#service.deleteRoom(roomId);
  }
  async addRoomMember(roomId: string, member: RoomMember): Promise<void> {
    await this.#service.addRoomMember(roomId, member);
  }
  async removeRoomMember(roomId: string, threadId: string): Promise<void> {
    await this.#service.removeRoomMember(roomId, threadId);
  }
  async postAgentRoomMessage(roomId: string, text: string): Promise<void> {
    await this.#service.postAgentRoomMessage(roomId, text);
  }
  async postRoomMessage(
    roomId: string,
    author: string,
    text: string,
  ): Promise<void> {
    await this.#service.postRoomMessage(roomId, author, text);
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#lifecycle.then(operation);
    this.#lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
  }
}

import { readFile, realpath, stat } from "node:fs/promises";
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
  RoomSendOperation,
  RoomDeliveryView,
  TriggerSnapshot,
  UpdateTriggerInput,
} from "./trigger-types.js";

export interface AutomationTargetPreview {
  workspace: string;
  resolvedWorkspace: string;
  model: string;
  providerProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "on-request" | "never";
  processEpoch: string;
  revision: number;
}

export async function createBundledAutomationPluginService(options: {
  userDataDirectory: string;
  appServer: ZenXTriggerAppServerPort;
  titles?: ZenXTriggerTitlePort;
  threadTargets?: ThreadTargetPort;
  targetDefaults?: () => Promise<
    Omit<AutomationTargetPreview, "workspace" | "resolvedWorkspace">
  >;
  startThread?: (preview: AutomationTargetPreview) => Promise<{
    thread: { id: string };
    cwd: string;
    model: string;
    sandbox: { type: string };
    approvalPolicy: string;
    reasoningEffort: string | null;
  }>;
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
    options.targetDefaults,
    options.startThread,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only this new automation admission needs an existing physical directory. */
async function resolveAutomationDirectory(workspace: string): Promise<string> {
  try {
    const resolved = await realpath(workspace);
    if ((await stat(resolved)).isDirectory()) return resolved;
  } catch {
    // Project's historical alias fallback is deliberately not admission here.
  }
  throw new Error(
    "Workspace directory is missing or not a directory; review it again",
  );
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
  // A bundled profile replacement may start its new runtime before the old
  // generation closes. Catalog enablement is one logical capability, but
  // both runtime instances must release their own transient lease.
  #triggerRuntimeLeases = 0;
  readonly #roomRuntimeLeases: ZenXPluginHostSdkV1[] = [];
  readonly #targets: ThreadTargetPort | undefined;
  readonly #appServer: ZenXTriggerAppServerPort;
  readonly #targetDefaults?: () => Promise<
    Omit<AutomationTargetPreview, "workspace" | "resolvedWorkspace">
  >;
  readonly #startThread?: NonNullable<
    Parameters<typeof createBundledAutomationPluginService>[0]["startThread"]
  >;
  #lifecycle: Promise<void> = Promise.resolve();

  constructor(
    appServer: ZenXTriggerAppServerPort,
    store: ZenXTriggerStorePort,
    active: Set<string>,
    titles?: ZenXTriggerTitlePort,
    targets?: ThreadTargetPort,
    targetDefaults?: () => Promise<
      Omit<AutomationTargetPreview, "workspace" | "resolvedWorkspace">
    >,
    startThread?: NonNullable<
      Parameters<typeof createBundledAutomationPluginService>[0]["startThread"]
    >,
  ) {
    this.#active = active;
    this.#appServer = appServer;
    this.#targets = targets;
    this.#targetDefaults = targetDefaults;
    this.#startThread = startThread;
    this.#service = new ZenXTriggerService(appServer, store, { titles });
  }

  async startPlugin(pluginId: string, sdk: ZenXPluginHostSdkV1): Promise<void> {
    await this.#serialize(async () => {
      if (
        pluginId === ZENX_TRIGGERS_CAPABILITY_ID &&
        this.#active.has(pluginId)
      ) {
        this.#triggerRuntimeLeases++;
        return;
      }
      if (
        pluginId === ZENX_ROOMS_CAPABILITY_ID &&
        this.#roomRuntimeLeases.includes(sdk)
      )
        return;
      const roomLease = pluginId === ZENX_ROOMS_CAPABILITY_ID;
      if (roomLease) this.#roomRuntimeLeases.push(sdk);
      if (this.#active.has(pluginId)) return;
      const first = this.#active.size === 0;
      if (first) {
        this.#active.add(pluginId);
        if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID)
          this.#triggerRuntimeLeases = 1;
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
        } catch (error) {
          this.#active.delete(pluginId);
          if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID)
            this.#triggerRuntimeLeases = 0;
          if (roomLease) this.#roomRuntimeLeases.pop();
          throw error;
        }
      } else {
        try {
          await this.#service.stop();
        } catch (error) {
          if (roomLease) this.#roomRuntimeLeases.pop();
          throw error;
        }
        this.#active.add(pluginId);
        if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID)
          this.#triggerRuntimeLeases = 1;
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
        } catch (error) {
          this.#active.delete(pluginId);
          if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID)
            this.#triggerRuntimeLeases = 0;
          if (roomLease) this.#roomRuntimeLeases.pop();
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
          throw error;
        }
      }
    });
  }

  async stopPlugin(
    pluginId: string,
    runtimeSdk?: ZenXPluginHostSdkV1,
  ): Promise<void> {
    await this.#serialize(async () => {
      if (pluginId === ZENX_ROOMS_CAPABILITY_ID) {
        // Old 1.0.x runtimes close without a token. Their lease was admitted
        // first; never let that close retire the already staged new runtime.
        const index =
          runtimeSdk === undefined
            ? 0
            : this.#roomRuntimeLeases.indexOf(runtimeSdk);
        if (index < 0 || index >= this.#roomRuntimeLeases.length) return;
        this.#roomRuntimeLeases.splice(index, 1);
        if (this.#roomRuntimeLeases.length > 0) return;
      }
      if (!this.#active.has(pluginId)) return;
      if (
        pluginId === ZENX_TRIGGERS_CAPABILITY_ID &&
        this.#triggerRuntimeLeases > 1
      ) {
        this.#triggerRuntimeLeases--;
        return;
      }
      if (this.#active.size === 1) {
        await this.#service.stop();
        this.#active.delete(pluginId);
      } else {
        this.#active.delete(pluginId);
      }
      if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID)
        this.#triggerRuntimeLeases = 0;
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
  async workspaces(): Promise<string[]> {
    const projection = this.#targets?.projectProjection;
    if (!projection?.configuredWorkspaces)
      throw new Error("Configured workspace discovery is unavailable");
    return await projection.configuredWorkspaces();
  }
  async previewTarget(workspace: string): Promise<AutomationTargetPreview> {
    const projection = this.#targets?.projectProjection;
    if (!projection?.configuredWorkspace || !this.#targetDefaults)
      throw new Error("Target preview is unavailable");
    const configured = await projection.configuredWorkspace(workspace);
    if (configured === null)
      throw new Error("Workspace is not configured; refresh projects");
    const resolvedWorkspace = await resolveAutomationDirectory(configured);
    const defaults = await this.#targetDefaults();
    if ((await projection.configuredWorkspace(configured)) !== configured)
      throw new Error(
        "Workspace configuration changed; refresh and confirm again",
      );
    if ((await resolveAutomationDirectory(configured)) !== resolvedWorkspace)
      throw new Error(
        "Workspace directory changed; review its actual location again",
      );
    return { workspace: configured, resolvedWorkspace, ...defaults };
  }
  async createTarget(
    workspace: string,
    expected: AutomationTargetPreview,
  ): Promise<{ threadId: string; effective: AutomationTargetPreview }> {
    if (this.#targets === undefined || this.#startThread === undefined)
      throw new Error("Creating a target Thread is unavailable");
    const current = await this.previewTarget(workspace);
    if (JSON.stringify(expected) !== JSON.stringify(current))
      throw new Error(
        "Workspace or Host defaults changed; refresh preview and confirm again",
      );
    // Last trusted workspace admission, independent of historical Thread cwd.
    if (
      (await this.#targets.projectProjection.configuredWorkspace?.(
        current.workspace,
      )) !== current.workspace
    )
      throw new Error(
        "Workspace was unconfigured; refresh preview and confirm again",
      );
    if (
      (await resolveAutomationDirectory(current.workspace)) !==
      current.resolvedWorkspace
    )
      throw new Error(
        "Workspace directory changed; review its actual location again",
      );
    const result = await this.#startThread(current);
    const sandboxType =
      current.sandbox === "danger-full-access"
        ? "dangerFullAccess"
        : current.sandbox === "read-only"
          ? "readOnly"
          : "workspaceWrite";
    if (
      result.cwd !== current.resolvedWorkspace ||
      result.model !== current.model ||
      result.sandbox.type !== sandboxType ||
      result.approvalPolicy !== current.approvalPolicy ||
      result.reasoningEffort !== current.reasoningEffort
    )
      throw new Error(
        `Thread ${result.thread.id} was created with different settings; inspect it before retrying`,
      );
    return { threadId: result.thread.id, effective: current };
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
      if (result.candidate.archived)
        throw new Error(
          `Thread target ${JSON.stringify(target)} is archived; unarchive it first`,
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
  async resume(triggerId: string, expectedRevision?: number): Promise<void> {
    const trigger = this.#service
      .snapshot()
      .triggers.find((item) => item.id === triggerId);
    if (trigger === undefined) throw new Error("Trigger was not found");
    if (
      expectedRevision !== undefined &&
      trigger.definitionRevision !== expectedRevision &&
      (trigger.definitionRevision !== undefined || expectedRevision !== 0)
    )
      throw new Error("Trigger definition changed; refresh before enabling");
    await this.#resolveInput({
      threadId: trigger.threadId,
      kind: "thread",
      label: trigger.label,
      prompt: trigger.prompt,
      watchedThreadId: trigger.watch?.threadId ?? trigger.threadId,
    });
    await this.#service.resume(triggerId, trigger);
  }
  async delete(triggerId: string): Promise<void> {
    await this.#service.delete(triggerId);
  }
  async signal(name: string, detail: string): Promise<void> {
    await this.#service.signal(name, detail);
  }
  async prepareRoomMessage(
    roomId: string,
    operationId: string,
    text: string,
  ): Promise<RoomSendOperation> {
    return await this.#service.prepareRoomMessage(roomId, operationId, text);
  }
  async postPreparedRoomMessage(
    roomId: string,
    operationId: string,
    text: string,
  ): Promise<RoomSendOperation> {
    return await this.#service.postPreparedRoomMessage(
      roomId,
      operationId,
      text,
    );
  }
  async cancelPreparedRoomOperation(roomId: string, operationId: string) {
    return await this.#service.cancelPreparedRoomOperation(roomId, operationId);
  }
  wakeupsEnabled(): boolean {
    return (
      this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID) &&
      this.#service.wakeupsEnabled()
    );
  }
  roomOperation(roomId: string, operationId: string): RoomDeliveryView {
    return this.#service.roomOperation(roomId, operationId);
  }
  roomDelivery(roomId: string, messageId: string) {
    return this.#service.roomDelivery(roomId, messageId);
  }
  async acknowledgeRoomOperation(
    roomId: string,
    operationId: string,
  ): Promise<void> {
    await this.#service.acknowledgeRoomOperation(roomId, operationId);
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

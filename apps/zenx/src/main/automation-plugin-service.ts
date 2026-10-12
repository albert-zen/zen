import { readFile, realpath, stat, unlink } from "node:fs/promises";
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
  type PluginStorageFileSystem,
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
  AssistantWorkspace,
  UpdateAssistantWorkspaceInput,
  ZenXRoom,
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

/** Host setup intent; the Room service only receives a real Thread binding. */
export interface CreateAssistantRoomInput {
  name: string;
  memberName: string;
  operationId: string;
  target:
    | { kind: "new"; workspace: string; expected: AutomationTargetPreview }
    | { kind: "existing"; threadId: string };
}

const MAX_ASSISTANT_CREATION_OPERATIONS = 256;

/** Remove the Room portion of the shared container when plugin data is deleted. */
export async function clearBundledAutomationRoomsData(
  userDataDirectory: string,
): Promise<void> {
  const root = path.join(userDataDirectory, "plugin-data");
  const filename = path.join(root, ZENX_TRIGGERS_CAPABILITY_ID, "storage.json");
  try {
    await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const storage = await JsonPluginStorage.open({
    pluginId: ZENX_TRIGGERS_CAPABILITY_ID,
    root,
    version: 1,
    initialValue: { triggers: [], history: [], rooms: [] },
  });
  const value = await storage.get();
  await storage.set({
    triggers: value["triggers"] ?? [],
    history: value["history"] ?? [],
    rooms: [],
  });
}

export async function createBundledAutomationPluginService(options: {
  userDataDirectory: string;
  /** Test seam for validating a failed container rename and restart. */
  storageFileSystem?: PluginStorageFileSystem;
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
  // A pre-existing Room namespace is authoritative during migration. Read it
  // before filling the shared Trigger container so a missing `rooms` field in
  // that container cannot overwrite newer Room data with the legacy fallback.
  const roomProjectionFile = path.join(
    storageRoot,
    ZENX_ROOMS_CAPABILITY_ID,
    "storage.json",
  );
  let roomProjection: JsonPluginStorage | undefined;
  let existingRooms: unknown;
  let roomProjectionError: unknown;
  const readStorageFile =
    options.storageFileSystem?.readFile ??
    ((filename: string, encoding: "utf8") => readFile(filename, encoding));
  try {
    await readStorageFile(roomProjectionFile, "utf8");
    roomProjection = await JsonPluginStorage.open({
      pluginId: ZENX_ROOMS_CAPABILITY_ID,
      root: storageRoot,
      version: 1,
      initialValue: { rooms: legacy.rooms },
      fileSystem: options.storageFileSystem,
    });
    const projectedRooms = (await roomProjection.get())["rooms"];
    // A generic plugin container only validates JSON shape. Validate the Room
    // namespace before allowing a legacy projection to seed the shared
    // Trigger document, otherwise malformed but parseable data can poison the
    // canonical store during migration.
    existingRooms = canonicalTriggerSnapshot({
      triggers: [],
      history: [],
      rooms: projectedRooms,
    }).rooms;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      roomProjectionError = error;
      console.error(
        `ZenX Room compatibility projection is unavailable: ${describeError(error)}`,
      );
    }
    roomProjection = undefined;
  }
  // Keep the historical Trigger filename as the physical container so old
  // readers continue to find their namespace; the document now also carries
  // the Room projection and is the sole commit point.
  const automationStorage = await JsonPluginStorage.open({
    pluginId: ZENX_TRIGGERS_CAPABILITY_ID,
    root: storageRoot,
    version: 1,
    initialValue: {
      triggers: legacy.triggers,
      history: legacy.history,
      rooms: existingRooms ?? legacy.rooms,
    },
    fileSystem: options.storageFileSystem,
  });
  const persistedAutomation = await automationStorage.get();
  if (!("rooms" in persistedAutomation)) {
    await automationStorage.set({
      triggers: persistedAutomation["triggers"] ?? legacy.triggers,
      history: persistedAutomation["history"] ?? legacy.history,
      rooms: existingRooms ?? legacy.rooms,
    });
  }
  const canonicalRooms = persistedAutomation["rooms"] ?? legacy.rooms;
  if (roomProjection === undefined && roomProjectionError === undefined) {
    try {
      roomProjection = await JsonPluginStorage.open({
        pluginId: ZENX_ROOMS_CAPABILITY_ID,
        root: storageRoot,
        version: 1,
        initialValue: { rooms: canonicalRooms },
        fileSystem: options.storageFileSystem,
      });
    } catch (error) {
      console.error(
        `ZenX Room compatibility projection is unavailable: ${describeError(error)}`,
      );
    }
  }
  if (roomProjection === undefined && roomProjectionError !== undefined) {
    // Only malformed, reconstructible data may be quarantined. Future-version
    // and permission failures must leave the original file untouched.
    if (isReconstructibleProjectionError(roomProjectionError)) {
      try {
        canonicalTriggerSnapshot({
          triggers: persistedAutomation["triggers"] ?? [],
          history: persistedAutomation["history"] ?? [],
          rooms: canonicalRooms,
        });
        await (options.storageFileSystem?.unlink ?? unlink)(roomProjectionFile);
        roomProjection = await JsonPluginStorage.open({
          pluginId: ZENX_ROOMS_CAPABILITY_ID,
          root: storageRoot,
          version: 1,
          initialValue: { rooms: canonicalRooms },
          fileSystem: options.storageFileSystem,
        });
      } catch (error) {
        console.error(
          `ZenX Room compatibility projection remains unavailable: ${describeError(error)}`,
        );
        roomProjection = undefined;
      }
    }
  }
  if (roomProjection !== undefined) {
    try {
      await roomProjection.set({ rooms: canonicalRooms });
    } catch (error) {
      console.error(
        `ZenX Room compatibility projection is stale; canonical state remains authoritative: ${describeError(error)}`,
      );
    }
  }
  const active = new Set<string>();
  return new ZenXBundledAutomationPluginService(
    options.appServer,
    new PluginAutomationStore(automationStorage, active, roomProjection),
    active,
    options.titles,
    options.threadTargets,
    options.targetDefaults,
    options.startThread,
  );
}

function isReconstructibleProjectionError(error: unknown): boolean {
  const message = describeError(error);
  return /invalid JSON|document is invalid|invalid entry shape|value must be|exceeds its byte limit/u.test(
    message,
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

class PluginAutomationStore implements ZenXTriggerStorePort {
  readonly #storage: JsonPluginStorage;
  readonly #active: ReadonlySet<string>;
  readonly #roomProjection: JsonPluginStorage | undefined;

  constructor(
    storage: JsonPluginStorage,
    active: ReadonlySet<string>,
    roomProjection: JsonPluginStorage | undefined,
  ) {
    this.#storage = storage;
    this.#active = active;
    this.#roomProjection = roomProjection;
  }

  async read(): Promise<TriggerSnapshot> {
    await this.#storage.reload();
    const data = await this.#storage.get();
    return canonicalTriggerSnapshot({
      triggers: data["triggers"],
      history: data["history"],
      rooms: data["rooms"],
    });
  }

  async write(snapshot: TriggerSnapshot): Promise<void> {
    const current = await this.#storage.get();
    const committed = {
      triggers: this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID)
        ? snapshot.triggers
        : (current["triggers"] ?? []),
      history: this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID)
        ? snapshot.history
        : (current["history"] ?? []),
      rooms: this.#active.has(ZENX_ROOMS_CAPABILITY_ID)
        ? snapshot.rooms
        : (current["rooms"] ?? []),
    };
    await this.#storage.set(committed);
    // The room namespace remains as a compatibility projection for older
    // runtimes. The shared Trigger document above is the sole authority. A
    // projection failure must not report a failed mutation after the
    // authoritative commit; startup resynchronizes this compatibility file.
    if (this.#active.has(ZENX_ROOMS_CAPABILITY_ID)) {
      try {
        if (this.#roomProjection !== undefined)
          await this.#roomProjection.set({ rooms: committed.rooms });
      } catch (error) {
        console.error(
          `ZenX Room compatibility projection is stale; canonical state committed: ${describeError(error)}`,
        );
      }
    }
  }
}

export class ZenXBundledAutomationPluginService implements ZenXAutomationControlPort {
  readonly #service: ZenXTriggerService;
  readonly #active: Set<string>;
  // A bundled profile replacement may start its new runtime before the old
  // generation closes. Catalog enablement is one logical capability, but
  // both runtime instances must release their own transient lease.
  #triggerRuntimeLeases = 0;
  readonly #triggerRuntimeSdks: ZenXPluginHostSdkV1[] = [];
  readonly #roomRuntimeLeases: ZenXPluginHostSdkV1[] = [];
  // Admission to storage is not proof that the underlying generation survived
  // a failed stop. Only an explicit start can re-read durable state.
  #serviceRunning = false;
  readonly #targets: ThreadTargetPort | undefined;
  readonly #appServer: ZenXTriggerAppServerPort;
  readonly #targetDefaults?: () => Promise<
    Omit<AutomationTargetPreview, "workspace" | "resolvedWorkspace">
  >;
  readonly #startThread?: NonNullable<
    Parameters<typeof createBundledAutomationPluginService>[0]["startThread"]
  >;
  #lifecycle: Promise<void> = Promise.resolve();
  // Bounded Host-lifetime UI receipts. Never retry an attempted thread/start,
  // including unknown transport outcomes; no durable recovery workflow.
  readonly #assistantCreations = new Map<
    string,
    { signature: string; result: Promise<ZenXRoom> }
  >();

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
      if (!this.#serviceRunning && this.#active.size > 0) {
        const admitted = this.#active.has(pluginId);
        if (!admitted) {
          this.#active.add(pluginId);
          if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
            this.#triggerRuntimeLeases = 1;
            this.#triggerRuntimeSdks.push(sdk);
          } else if (pluginId === ZENX_ROOMS_CAPABILITY_ID) {
            this.#roomRuntimeLeases.push(sdk);
          }
        }
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
          this.#serviceRunning = true;
        } catch (error) {
          if (!admitted) {
            this.#active.delete(pluginId);
            if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
              this.#triggerRuntimeLeases = 0;
              this.#triggerRuntimeSdks.pop();
            } else if (pluginId === ZENX_ROOMS_CAPABILITY_ID) {
              this.#roomRuntimeLeases.pop();
            }
          }
          throw error;
        }
        if (admitted && pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
          if (!this.#triggerRuntimeSdks.includes(sdk)) {
            this.#triggerRuntimeLeases++;
            this.#triggerRuntimeSdks.push(sdk);
          }
        } else if (
          admitted &&
          pluginId === ZENX_ROOMS_CAPABILITY_ID &&
          !this.#roomRuntimeLeases.includes(sdk)
        ) {
          this.#roomRuntimeLeases.push(sdk);
        }
        return;
      }
      if (
        pluginId === ZENX_TRIGGERS_CAPABILITY_ID &&
        this.#active.has(pluginId)
      ) {
        this.#triggerRuntimeLeases++;
        this.#triggerRuntimeSdks.push(sdk);
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
        if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
          this.#triggerRuntimeLeases = 1;
          this.#triggerRuntimeSdks.push(sdk);
        }
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
          this.#serviceRunning = true;
        } catch (error) {
          this.#active.delete(pluginId);
          if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
            this.#triggerRuntimeLeases = 0;
            this.#triggerRuntimeSdks.pop();
          }
          if (roomLease) this.#roomRuntimeLeases.pop();
          throw error;
        }
      } else {
        try {
          await this.#service.stop();
          this.#serviceRunning = false;
        } catch (error) {
          this.#serviceRunning = false;
          if (roomLease) this.#roomRuntimeLeases.pop();
          throw error;
        }
        this.#active.add(pluginId);
        if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
          this.#triggerRuntimeLeases = 1;
          this.#triggerRuntimeSdks.push(sdk);
        }
        try {
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
          this.#serviceRunning = true;
        } catch (error) {
          this.#active.delete(pluginId);
          if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
            this.#triggerRuntimeLeases = 0;
            this.#triggerRuntimeSdks.pop();
          }
          if (roomLease) this.#roomRuntimeLeases.pop();
          await this.#service.start(
            this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID),
          );
          this.#serviceRunning = true;
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
        this.#triggerRuntimeSdks.shift();
        return;
      }
      const last = this.#active.size === 1;
      try {
        if (last && this.#serviceRunning) await this.#service.stop();
      } catch (error) {
        // TriggerService.stop retires the generation even when its durable
        // write fails. This invocation must not retain a ghost lease.
        this.#serviceRunning = false;
        this.#active.delete(pluginId);
        if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
          this.#triggerRuntimeLeases = 0;
          this.#triggerRuntimeSdks.length = 0;
        }
        throw error;
      }
      if (last) this.#serviceRunning = false;
      this.#active.delete(pluginId);
      if (pluginId === ZENX_TRIGGERS_CAPABILITY_ID) {
        this.#triggerRuntimeLeases = 0;
        this.#triggerRuntimeSdks.length = 0;
      }
      if (
        this.#serviceRunning &&
        this.#active.size > 0 &&
        pluginId === ZENX_TRIGGERS_CAPABILITY_ID
      )
        this.#service.suspendWakeups();
    });
  }

  onChange(listener: (snapshot: TriggerSnapshot) => void): () => void {
    return this.#service.onChange(listener);
  }
  roomsAvailable(): boolean {
    return this.#serviceRunning && this.#active.has(ZENX_ROOMS_CAPABILITY_ID);
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
    return await this.#createTarget(workspace, expected);
  }

  async #createTarget(
    workspace: string,
    expected: AutomationTargetPreview,
    onStart?: () => void,
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
    onStart?.();
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

  async result(
    historyId: string,
  ): ReturnType<NonNullable<ZenXAutomationControlPort["result"]>> {
    const entry = this.#service
      .snapshot()
      .history.find((item) => item.id === historyId);
    if (entry?.sourceThreadId == null || entry.sourceTurnId == null)
      throw new Error(
        "Source result was not found in retained notification history",
      );
    if (entry.sourceDevice !== undefined) {
      if (!this.#appServer.readRemoteThread)
        throw new Error("Reading remote Thread results is unavailable");
      const read = await this.#appServer.readRemoteThread(
        entry.sourceDevice,
        entry.sourceWorkspace,
        entry.sourceThreadId,
        entry.sourceTurnId,
      );
      if (read.threadId !== entry.sourceThreadId)
        throw new Error("Remote source Thread identity changed");
      const turn = read.turns.find((item) => item.id === entry.sourceTurnId);
      if (!turn) throw new Error("Remote source Turn is unavailable");
      return {
        sourceDevice: entry.sourceDevice,
        ...(entry.sourceWorkspace === undefined
          ? {}
          : { sourceWorkspace: entry.sourceWorkspace }),
        threadId: entry.sourceThreadId,
        turnId: turn.id,
        status: turn.status,
        preview: turn.preview,
      };
    }
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
    const resolve = async (target: string) => {
      if (this.#targets === undefined) return target;
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
    if (
      input.kind === "thread" &&
      input.sourceDevice !== undefined &&
      input.sourceDevice.trim() !== "local"
    ) {
      if (
        !this.#appServer.resolveRemoteThread ||
        !this.#appServer.subscribeRemoteThread
      )
        throw new Error("Remote Thread observation is unavailable");
      const sourceDevice = input.sourceDevice.trim();
      const resolved = await this.#appServer.resolveRemoteThread(
        sourceDevice,
        input.sourceWorkspace,
        input.watchedThreadId,
      );
      return {
        ...input,
        threadId,
        sourceDevice,
        watchedThreadId: resolved.threadId,
        ...(resolved.workspace === undefined
          ? {}
          : { sourceWorkspace: resolved.workspace }),
      };
    }
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
    const resolved = await this.#resolveInput({
      threadId: trigger.threadId,
      kind: "thread",
      label: trigger.label,
      prompt: trigger.prompt,
      watchedThreadId: trigger.watch?.threadId ?? trigger.threadId,
      ...(trigger.watch?.sourceDevice === undefined
        ? {}
        : { sourceDevice: trigger.watch.sourceDevice }),
      ...(trigger.watch?.sourceWorkspace === undefined
        ? {}
        : { sourceWorkspace: trigger.watch.sourceWorkspace }),
    });
    if (
      trigger.watch?.sourceDevice !== undefined &&
      (resolved.kind !== "thread" ||
        resolved.watchedThreadId !== trigger.watch.threadId ||
        resolved.sourceDevice !== trigger.watch.sourceDevice ||
        resolved.sourceWorkspace !== trigger.watch.sourceWorkspace)
    )
      throw new Error(
        "Remote Trigger source identity changed; edit its definition before enabling",
      );
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
    replyToMessageId?: string,
  ): Promise<RoomSendOperation> {
    return await this.#service.prepareRoomMessage(
      roomId,
      operationId,
      text,
      replyToMessageId,
    );
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
    return this.#service.roomMessageReceipt(roomId, messageId);
  }
  async setRoomReaction(
    roomId: string,
    messageId: string,
    actorThreadId: string | null,
    emoji: string | null,
  ) {
    return await this.#service.setRoomReaction(
      roomId,
      messageId,
      actorThreadId,
      emoji,
    );
  }
  async acknowledgeRoomOperation(
    roomId: string,
    operationId: string,
  ): Promise<void> {
    await this.#service.acknowledgeRoomOperation(roomId, operationId);
  }
  async createAssistantRoom(
    input: CreateAssistantRoomInput | CreateRoomInput,
  ): Promise<ZenXRoom> {
    const captured = structuredClone(input);
    // Cached 1.0.x Rooms runtimes explicitly supply their existing binding.
    if ("members" in captured) {
      if ("target" in captured)
        throw new Error("Choose either a new or existing PAW Thread");
      return await this.#serialize(async () => {
        this.#requireAssistantSetup();
        const validated = this.#service.validateAssistantRoom(captured);
        return await this.#bindAssistantRoom(validated);
      });
    }
    const operationId = captured.operationId;
    if (
      typeof operationId !== "string" ||
      !operationId.trim() ||
      Buffer.byteLength(operationId, "utf8") > 512
    )
      throw new Error("PAW creation operation ID is required and bounded");
    const signature = JSON.stringify(captured);
    const previous = this.#assistantCreations.get(operationId);
    if (previous !== undefined) {
      if (previous.signature !== signature)
        throw new Error(
          "PAW creation operation was already used with different input",
        );
      return structuredClone(await previous.result);
    }
    if (this.#assistantCreations.size >= MAX_ASSISTANT_CREATION_OPERATIONS)
      throw new Error(
        "PAW setup operation limit reached; restart Host before creating another",
      );
    let threadStartAttempted = false;
    const result = this.#serialize(async () => {
      this.#requireAssistantSetup();
      if (
        !captured.target ||
        !["new", "existing"].includes(captured.target.kind)
      )
        throw new Error("Choose a new or existing PAW Thread");
      const validated = this.#service.validateAssistantRoom({
        name: captured.name,
        members: [
          {
            name: captured.memberName,
            threadId:
              captured.target.kind === "existing"
                ? captured.target.threadId
                : "pending-new-thread",
          },
        ],
      });
      if (captured.target.kind === "existing")
        return await this.#bindAssistantRoom(validated);
      let threadId: string | undefined;
      try {
        const created = await this.#createTarget(
          captured.target.workspace,
          captured.target.expected,
          () => {
            threadStartAttempted = true;
          },
        );
        threadId = created.threadId;
        this.#requireAssistantSetup();
        return await this.#service.createAssistantRoom({
          name: validated.name,
          members: [{ name: validated.members[0]!.name, threadId }],
        });
      } catch (error) {
        if (!threadStartAttempted) throw error;
        if (threadId !== undefined)
          throw new Error(
            `Thread ${threadId} was created, but PAW setup failed: ${describeError(error)}. Inspect it and explicitly bind that existing Thread; this operation will not create another Thread`,
          );
        throw new Error(
          `PAW Thread creation could not be confirmed: ${describeError(error)}. Inspect Threads before trying again; this operation will not retry Thread creation`,
        );
      }
    });
    const receipt = { signature, result };
    this.#assistantCreations.set(operationId, receipt);
    try {
      return structuredClone(await result);
    } catch (error) {
      // Pure validation/binding failures can be corrected with the same draft.
      // Once creation was attempted, retain failure to fence duplicate Threads.
      if (
        !threadStartAttempted &&
        this.#assistantCreations.get(operationId) === receipt
      )
        this.#assistantCreations.delete(operationId);
      throw error;
    }
  }

  #requireAssistantSetup(): void {
    if (
      !this.#serviceRunning ||
      !this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID) ||
      !this.#active.has(ZENX_ROOMS_CAPABILITY_ID)
    )
      throw new Error("Enable Rooms and Triggers before creating an assistant");
  }

  async #bindAssistantRoom(input: CreateRoomInput): Promise<ZenXRoom> {
    if (input.members.length !== 1 || this.#targets === undefined)
      throw new Error("Select one available existing Thread");
    const member = input.members[0]!;
    const target = await resolveThreadTarget(this.#targets, {
      target: member.threadId,
    });
    if (target.status !== "resolved" || target.candidate.archived)
      throw new Error("Assistant Thread is unavailable or archived");
    this.#requireAssistantSetup();
    return await this.#service.createAssistantRoom({
      name: input.name,
      members: [{ name: member.name, threadId: target.threadId }],
    });
  }
  async setAssistantReplies(roomId: string, enabled: boolean) {
    if (!this.#active.has(ZENX_TRIGGERS_CAPABILITY_ID))
      throw new Error("Triggers are disabled");
    const room = this.#service
      .snapshot()
      .rooms.find((entry) => entry.id === roomId);
    if (!room?.assistant) throw new Error("Assistant Room was not found");
    if (enabled) await this.resume(room.assistant.triggerId);
    else await this.cancel(room.assistant.triggerId);
  }
  async createRoom(input: CreateRoomInput) {
    return await this.#service.createRoom(input);
  }
  assistantWorkspace(roomId: string): AssistantWorkspace {
    if (!this.roomsAvailable())
      throw Error("Rooms are disabled or unavailable");
    return this.#service.assistantWorkspace(roomId);
  }
  async updateAssistantWorkspace(
    input: UpdateAssistantWorkspaceInput,
  ): Promise<AssistantWorkspace> {
    const captured = structuredClone(input);
    return await this.#serialize(async () => {
      if (!this.roomsAvailable())
        throw Error("Rooms are disabled or unavailable");
      return await this.#service.updateAssistantWorkspace(captured);
    });
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
  async postAgentRoomMessage(
    roomId: string,
    text: string,
    replyToMessageId?: string,
    callingThreadId?: string,
  ): Promise<void> {
    await this.#service.postAgentRoomMessage(
      roomId,
      text,
      replyToMessageId,
      callingThreadId,
    );
  }
  async postRoomMessage(
    roomId: string,
    author: string,
    text: string,
  ): Promise<void> {
    await this.#service.postRoomMessage(roomId, author, text);
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycle.then(operation);
    this.#lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

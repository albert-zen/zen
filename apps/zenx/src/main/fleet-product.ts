import { fleetDeviceKey } from "./fleet.js";
export { fleetDeviceKey } from "./fleet.js";
import type { FleetSettingsService } from "./fleet-settings.js";

export interface FleetThreadLocator {
  deviceId: string;
  deviceKey: string;
  hostId?: string;
  workspace: string;
  threadId: string;
}
export interface FleetTargetCatalog {
  machine: {
    id: string;
    key: string;
    hostId?: string;
    label: string;
    description?: string;
    access: "read" | "control";
    shellEnabled: boolean;
  };
  workspaces: Array<{ id: string; label: string }>;
  models: Array<{
    id: string;
    label: string;
    isDefault: boolean;
    efforts: string[];
    defaultEffort: string | null;
  }>;
  preferredWorkspace?: string;
}
/** Target-scoped desktop operations; no transcript, execution state or retry authority. */
export class FleetProductService {
  constructor(readonly fleet: FleetSettingsService) {}
  async #peer(id: string, key?: string) {
    if (!id || id === "local")
      throw new Error(
        "Choose an explicit remote machine; local conversations use the ordinary Zen entry",
      );
    const peer = (await this.fleet.config()).devices.find(
      (value) => value.id === id,
    );
    if (!peer)
      throw new Error(
        "This Fleet machine was removed. Choose another machine; no local fallback was attempted.",
      );
    if (key && fleetDeviceKey(peer) !== key)
      throw new Error(
        "This Fleet machine's connection, access or workspace changed. Reopen its catalog before continuing; this Thread was not retargeted.",
      );
    return peer;
  }
  async catalog(deviceId: string): Promise<FleetTargetCatalog> {
    const peer = await this.#peer(deviceId);
    const key = fleetDeviceKey(peer);
    const [projects, models] = await Promise.all([
      this.fleet.invoke({
        device: deviceId,
        expectedDeviceKey: key,
        name: "zenx_projects_list",
        arguments: { limit: 100 },
      }),
      this.fleet.invoke({
        device: deviceId,
        expectedDeviceKey: key,
        name: "zenx_models_list",
        arguments: {},
      }),
    ]);
    await this.#peer(deviceId, key);
    return {
      machine: {
        id: deviceId,
        key,
        label: peer.label,
        ...(peer.description ? { description: peer.description } : {}),
        ...(peer.transport === "https" ? { hostId: peer.hostId } : {}),
        access: peer.access,
        shellEnabled:
          peer.transport === "https" &&
          peer.access === "control" &&
          peer.shellEnabled === true,
      },
      workspaces: rows(unwrap(projects).projects).map((value) => ({
        id: text(
          value.project ?? value.workspace ?? value.cwd ?? value.id,
          "workspace identity",
        ),
        label: text(
          value.name ?? value.label ?? value.workspace ?? value.cwd ?? value.id,
          "workspace label",
        ),
      })),
      models: rows(unwrap(models).models).map((value) => ({
        id: text(value.id, "model ID"),
        label: text(
          value.displayName ?? value.model ?? value.id,
          "model label",
        ),
        isDefault: value.isDefault === true,
        efforts: Array.isArray(value.supportedReasoningEfforts)
          ? value.supportedReasoningEfforts.map((entry) =>
              text(object(entry).reasoningEffort, "reasoning effort"),
            )
          : [],
        defaultEffort:
          typeof value.defaultReasoningEffort === "string"
            ? value.defaultReasoningEffort
            : null,
      })),
      ...(peer.transport === "https" && peer.workspace
        ? { preferredWorkspace: peer.workspace }
        : {}),
    };
  }
  async list(input: {
    deviceId: string;
    deviceKey: string;
    workspace: string;
  }) {
    await this.#peer(
      input.deviceId,
      text(input.deviceKey, "machine connection identity"),
    );
    const result = unwrap(
      await this.fleet.invoke({
        device: input.deviceId,
        expectedDeviceKey: input.deviceKey,
        name: "zenx_threads_list",
        arguments: {
          workspace: text(input.workspace, "workspace"),
          limit: 100,
        },
      }),
    );
    await this.#peer(
      input.deviceId,
      text(input.deviceKey, "machine connection identity"),
    );
    return {
      threads: rows(result.threads).map((value) => ({
        id: text(value.threadId ?? value.id, "Thread identity"),
        label:
          typeof value.name === "string" && value.name
            ? value.name
            : typeof value.preview === "string" && value.preview
              ? value.preview
              : text(value.threadId ?? value.id, "Thread identity"),
        status: typeof value.status === "string" ? value.status : "unknown",
      })),
      truncated: result.truncated === true,
    };
  }
  async create(input: {
    deviceId: string;
    deviceKey: string;
    workspace: string;
    model: string;
    effort?: string;
  }): Promise<FleetThreadLocator> {
    const peer = await this.#peer(
      input.deviceId,
      text(input.deviceKey, "machine connection identity"),
    );
    if (peer.access !== "control")
      throw new Error(
        "This machine is read-only. Pair with a fresh control grant before creating work.",
      );
    const result = unwrap(
      await this.fleet.invoke({
        device: input.deviceId,
        expectedDeviceKey: input.deviceKey,
        name: "zenx_threads_create",
        arguments: {
          project: text(input.workspace, "workspace"),
          model: text(input.model, "target model"),
          ...(input.effort ? { effort: input.effort } : {}),
        },
      }),
    );
    const threadId = text(result.threadId, "created Thread ID");
    // A real create receipt remains inspectable even if configuration changes afterwards.
    return {
      deviceId: peer.id,
      deviceKey: input.deviceKey,
      ...(peer.transport === "https" ? { hostId: peer.hostId } : {}),
      workspace: input.workspace,
      threadId,
    };
  }
  async read(locator: FleetThreadLocator, cursor?: string) {
    await this.#assertLocator(locator);
    const result = unwrap(
      await this.fleet.invoke({
        device: locator.deviceId,
        expectedDeviceKey: locator.deviceKey,
        name: "zenx_threads_read",
        arguments: {
          threadId: locator.threadId,
          ...(await this.#workspaceArgs(locator)),
          granularity: "items",
          maxItemsPerTurn: 25,
          ...(cursor ? { cursor } : {}),
        },
      }),
    );
    await this.#assertLocator(locator);
    if (result.status === "not_found" || result.status === "ambiguous")
      throw new Error(
        "The exact remote Thread is unavailable; no same-ID local Thread was opened.",
      );
    return result;
  }
  async status(locator: FleetThreadLocator) {
    await this.#assertLocator(locator);
    const result = unwrap(
      await this.fleet.invoke({
        device: locator.deviceId,
        expectedDeviceKey: locator.deviceKey,
        name: "zenx_threads_status",
        arguments: {
          threadId: locator.threadId,
          ...(await this.#workspaceArgs(locator)),
        },
      }),
    );
    if (result.status === "not_found" || result.status === "ambiguous")
      throw new Error(
        "The exact remote Thread is unavailable; no same-ID local Thread was opened.",
      );
    return result;
  }
  async send(input: {
    locator: FleetThreadLocator;
    text: string;
    messageType?: "guidance" | "follow_up" | "replacement";
  }) {
    const peer = await this.#assertLocator(input.locator);
    if (peer.access !== "control")
      throw new Error(
        "This machine is read-only; remote messages were not sent.",
      );
    const result = unwrap(
      await this.fleet.invoke({
        device: peer.id,
        expectedDeviceKey: input.locator.deviceKey,
        name: "zenx_threads_send",
        arguments: {
          threadId: input.locator.threadId,
          ...(await this.#workspaceArgs(input.locator)),
          text: text(input.text, "message"),
          messageType: input.messageType ?? "guidance",
        },
      }),
    );
    if (result.status === "not_found" || result.status === "ambiguous")
      throw new Error(
        "The exact remote Thread is unavailable; no message was sent or locally substituted.",
      );
    return result;
  }
  async #assertLocator(locator: FleetThreadLocator) {
    const peer = await this.#peer(
      text(locator.deviceId, "machine"),
      text(locator.deviceKey, "machine connection identity"),
    );
    text(locator.workspace, "workspace");
    text(locator.threadId, "Thread");
    if (peer.transport === "https" && locator.hostId !== peer.hostId)
      throw new Error(
        "This conversation belongs to another Host identity; it was not retargeted.",
      );
    return peer;
  }
  async #workspaceArgs(locator: FleetThreadLocator) {
    await this.#assertLocator(locator);
    return { workspace: locator.workspace };
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid target Fleet response");
  return value as Record<string, unknown>;
}
function unwrap(value: unknown) {
  const result = object(value);
  return result.device !== undefined && result.result !== undefined
    ? object(result.result)
    : result;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid target Fleet list");
  return value.map(object);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Fleet requires ${name}`);
  return value;
}

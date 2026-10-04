import type { ToolInvocation } from "../../../../../src/tool.js";
import { fleetManifest } from "../../../../../packages/zenx-fleet-plugin/src/manifest.js";
import type { FleetSettingsService } from "../fleet-settings.js";
import type { ZenXCapabilityPackage } from "./types.js";
import type { ZenXSelfControlCapabilityPackage } from "./self-control-package.js";

const mapped = {
  zenx_fleet_workspaces: "zenx_projects_list",
  zenx_fleet_models: "zenx_models_list",
  zenx_fleet_threads_list: "zenx_threads_list",
  zenx_fleet_threads_read: "zenx_threads_read",
  zenx_fleet_threads_create: "zenx_threads_create",
  zenx_fleet_threads_send: "zenx_threads_send",
  zenx_fleet_threads_status: "zenx_threads_status",
} as const;
export class ZenXFleetCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = fleetManifest;
  constructor(
    readonly options: {
      threads: ZenXSelfControlCapabilityPackage;
      fleet: FleetSettingsService;
    },
  ) {}
  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    const tool = this.manifest.tools.find((value) => value.name === name);
    if (!tool || invocation.name !== name)
      throw new Error("Unsupported Fleet tool");
    invocation.signal.throwIfAborted();
    const args =
      invocation.trustedPluginUi === true &&
      invocation.arguments.input !== undefined
        ? record(invocation.arguments.input)
        : invocation.arguments;
    const allowed = Object.keys(record(tool.inputSchema.properties));
    for (const key of Object.keys(args))
      if (!allowed.includes(key))
        throw new Error(`Unexpected Fleet argument: ${key}`);
    if (name === "zenx_fleet_devices")
      return {
        source: "zenx.fleet",
        devices: await this.options.fleet.devices(),
      };
    if (name === "zenx_fleet_probe") {
      const id = string(args.device, "device");
      if (id !== "local") await this.options.fleet.test(id, invocation.signal);
      return {
        source: "zenx.fleet",
        device: (await this.options.fleet.devices()).find(
          (value) => value.id === id,
        ),
      };
    }
    if (name === "zenx_fleet_shell") {
      const id = string(args.device, "device");
      if (id === "local")
        throw new Error(
          "Use the ordinary local shell tool for this Host; Fleet shell requires an explicit remote device",
        );
      return await this.options.fleet.router.invoke(id, {
        ...invocation,
        arguments: args,
      });
    }
    const target = mapped[name as keyof typeof mapped];
    if (!target) throw new Error("Unsupported Fleet tool");
    const forwarded = { ...args };
    if (name === "zenx_fleet_threads_create") {
      forwarded.project = string(args.workspace, "workspace");
      delete forwarded.workspace;
    }
    return await this.options.threads.invoke(target, {
      ...invocation,
      name: target,
      arguments: forwarded,
    });
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected Fleet argument object");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Fleet requires ${name}`);
  return value;
}

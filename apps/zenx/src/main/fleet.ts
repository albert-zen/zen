import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import type { ToolInvocation } from "../../../../src/tool.js";
import { originAuthority } from "../../../../src/protocol/native/remote-transport.js";

/** Only administrator-owned configuration can add destinations or commands. */
interface FleetDeviceBase {
  id: string;
  label: string;
  /** User-authored usage guidance, never an authorization or execution input. */
  description?: string;
  shellEnabled?: boolean;
  toolsEnabled?: boolean;
  access: "read" | "control";
}
export interface SshFleetDevice extends FleetDeviceBase {
  transport?: "ssh";
  sshHost: string;
  command: string[];
}
export interface NativeFleetDevice extends FleetDeviceBase {
  transport: "https";
  endpoint: string;
  hostId: string;
  workspace?: string;
}
export type FleetDevice = SshFleetDevice | NativeFleetDevice;
export function fleetDeviceKey(peer: FleetDevice): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        peer.transport === "https"
          ? [
              peer.id,
              peer.transport,
              peer.hostId,
              peer.endpoint,
              peer.workspace ?? null,
              peer.access,
              peer.shellEnabled === true,
              peer.toolsEnabled === true,
            ]
          : [peer.id, "ssh", peer.sshHost, peer.command, peer.access],
      ),
    )
    .digest("hex");
}
export interface FleetDeviceDiscovery {
  id: string;
  label: string;
  description?: string;
  key?: string;
  shellEnabled?: boolean;
  toolsEnabled?: boolean;
  transport: "local" | "ssh" | "https";
  access: "read" | "control";
  status: "local" | "not_checked";
}
export interface FleetHostingConfig {
  enabled: boolean;
  bindAddress: string;
  port: number;
  tlsCertificateFile: string;
  tlsKeyFile: string;
  relayEndpoint?: string;
  originEndpoint?: string;
  shellEnabled?: boolean;
  toolsEnabled?: boolean;
  access: "read" | "control";
}
export interface FleetConfig {
  version: 1;
  devices: FleetDevice[];
  hosting?: FleetHostingConfig;
  revision?: number;
}
export interface NativeFleetPort {
  invoke(
    device: NativeFleetDevice,
    request: FleetRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface FleetRequest {
  version: 1 | 2;
  name: string;
  arguments: Record<string, unknown>;
  callId: string;
  canonicalToolCallId?: string;
  threadId?: string;
}
export const fleetReadTools = new Set([
  "zenx_projects_list",
  "zenx_models_list",
  "zenx_threads_list",
  "zenx_threads_read",
  "zenx_threads_status",
  "zenx_self_control_threads_wait",
]);
export const fleetTools = new Set([
  ...fleetReadTools,
  "zenx_threads_create",
  "zenx_threads_send",
  "zenx_fleet_shell",
]);
export type FleetTransport = (
  device: FleetDevice,
  request: FleetRequest,
  signal: AbortSignal,
) => Promise<unknown>;

/** A direct TLS authority, never a bearer-bearing or redirected URL. */
export function normalizeFleetEndpoint(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    !/^https:\/\//u.test(value)
  )
    throw new Error("Fleet endpoint must be a direct HTTPS URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Fleet HTTPS endpoint");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("@")
  )
    throw new Error(
      "Fleet endpoint must be a direct HTTPS authority without credentials or query",
    );
  return url.origin;
}
const fleetRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fleetString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  !/[\x00-\x1f\x7f]/u.test(value);
const fleetKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const fleetTlsPath = (value: unknown, enabled: boolean): value is string =>
  typeof value === "string" &&
  value.length <= 4096 &&
  !/[\x00-\x1f\x7f]/u.test(value) &&
  (!enabled || value.trim().length > 0);
export function parseFleetConfig(value: unknown): FleetConfig {
  if (
    !fleetRecord(value) ||
    !fleetKeys(value, ["version", "devices", "hosting", "revision"]) ||
    value.version !== 1 ||
    !Array.isArray(value.devices) ||
    value.devices.length > 64 ||
    (value.revision !== undefined &&
      (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0))
  )
    throw new Error("Invalid Fleet configuration");
  const ids = new Set<string>();
  const devices = value.devices.map((device): FleetDevice => {
    if (
      !fleetRecord(device) ||
      typeof device.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(device.id) ||
      device.id === "local" ||
      ids.has(device.id) ||
      !fleetString(device.label, 120) ||
      (device.shellEnabled !== undefined &&
        (typeof device.shellEnabled !== "boolean" ||
          (device.shellEnabled && device.access !== "control"))) ||
      (device.toolsEnabled !== undefined &&
        (typeof device.toolsEnabled !== "boolean" ||
          (device.toolsEnabled &&
            (device.access !== "control" || device.transport !== "https")))) ||
      (device.description !== undefined &&
        (typeof device.description !== "string" ||
          device.description.length > 4000 ||
          device.description.includes("\0"))) ||
      (device.access !== "read" && device.access !== "control")
    )
      throw new Error("Invalid Fleet device configuration");
    ids.add(device.id);
    if (device.transport === "https") {
      if (
        !fleetKeys(device, [
          "id",
          "label",
          "description",
          "shellEnabled",
          "toolsEnabled",
          "transport",
          "endpoint",
          "hostId",
          "access",
          "workspace",
        ]) ||
        !fleetString(device.hostId, 128) ||
        (device.workspace !== undefined && !fleetString(device.workspace, 128))
      )
        throw new Error("Invalid Fleet HTTPS device configuration");
      return {
        ...device,
        endpoint: normalizeFleetEndpoint(device.endpoint),
      } as unknown as NativeFleetDevice;
    }
    if (
      (device.transport !== undefined && device.transport !== "ssh") ||
      !fleetKeys(device, [
        "id",
        "label",
        "description",
        "shellEnabled",
        "toolsEnabled",
        "transport",
        "sshHost",
        "command",
        "access",
      ]) ||
      typeof device.sshHost !== "string" ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,253}$/u.test(device.sshHost) ||
      !Array.isArray(device.command) ||
      device.command.length < 1 ||
      device.command.length > 16 ||
      device.command.some((arg) => !fleetString(arg, 4096))
    )
      throw new Error("Invalid Fleet SSH device configuration");
    return structuredClone(device) as unknown as SshFleetDevice;
  });
  if (value.hosting !== undefined) {
    const hosting = value.hosting;
    if (
      !fleetRecord(hosting) ||
      !fleetKeys(hosting, [
        "enabled",
        "bindAddress",
        "port",
        "tlsCertificateFile",
        "tlsKeyFile",
        "relayEndpoint",
        "originEndpoint",
        "shellEnabled",
        "toolsEnabled",
        "access",
      ]) ||
      typeof hosting.enabled !== "boolean" ||
      (hosting.shellEnabled !== undefined &&
        (typeof hosting.shellEnabled !== "boolean" ||
          (hosting.shellEnabled && hosting.access !== "control"))) ||
      (hosting.toolsEnabled !== undefined &&
        (typeof hosting.toolsEnabled !== "boolean" ||
          (hosting.toolsEnabled && hosting.access !== "control"))) ||
      typeof hosting.bindAddress !== "string" ||
      !/^[a-zA-Z0-9_.:[\]-]{1,253}$/u.test(hosting.bindAddress) ||
      !Number.isInteger(hosting.port) ||
      (hosting.port as number) < 1 ||
      (hosting.port as number) > 65535 ||
      !fleetTlsPath(hosting.tlsCertificateFile, hosting.enabled) ||
      !fleetTlsPath(hosting.tlsKeyFile, hosting.enabled) ||
      (hosting.access !== "read" && hosting.access !== "control")
    )
      throw new Error("Invalid Fleet hosting configuration");
    if (hosting.relayEndpoint !== undefined)
      normalizeFleetEndpoint(hosting.relayEndpoint);
    if (hosting.originEndpoint !== undefined) {
      if (typeof hosting.originEndpoint !== "string")
        throw new Error("Invalid Fleet Android Origin endpoint");
      if (originAuthority(hosting.originEndpoint).port !== hosting.port)
        throw new Error(
          "Remote Origin endpoint port must equal the bound port",
        );
    }
  }
  const result = {
    ...structuredClone(value),
    devices,
  } as unknown as FleetConfig;
  if (result.hosting?.relayEndpoint !== undefined)
    result.hosting.relayEndpoint = normalizeFleetEndpoint(
      result.hosting.relayEndpoint,
    );
  return result;
}
export async function readFleetConfig(file: string): Promise<FleetConfig> {
  try {
    return parseFleetConfig(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, devices: [] };
    throw error;
  }
}
export class FleetRouter {
  constructor(
    readonly config: () => Promise<FleetConfig>,
    readonly transport: FleetTransport = sshFleetTransport,
    readonly native?: NativeFleetPort,
  ) {}
  async devices(snapshot?: FleetConfig): Promise<FleetDeviceDiscovery[]> {
    const config = snapshot ?? (await this.config());
    return [
      {
        id: "local",
        label: "This device",
        transport: "local",
        access: "control",
        status: "local",
      },
      ...config.devices.map(
        ({ id, label, description, access, transport }) => ({
          id,
          key: fleetDeviceKey(config.devices.find((peer) => peer.id === id)!),
          label,
          ...(description === undefined ? {} : { description }),
          access,
          transport: transport ?? "ssh",
          status: "not_checked" as const,
          shellEnabled:
            transport === "https" &&
            access === "control" &&
            config.devices.find((entry) => entry.id === id)?.shellEnabled ===
              true,
          toolsEnabled:
            transport === "https" &&
            access === "control" &&
            config.devices.find((entry) => entry.id === id)?.toolsEnabled ===
              true,
        }),
      ),
    ];
  }
  async invoke(
    deviceId: string,
    invocation: ToolInvocation,
    expectedDeviceKey?: string,
  ): Promise<unknown> {
    invocation.signal.throwIfAborted();
    const device = (await this.config()).devices.find(
      (device) => device.id === deviceId,
    );
    if (!device) throw new Error(`Unknown Fleet device: ${deviceId}`);
    if (expectedDeviceKey && fleetDeviceKey(device) !== expectedDeviceKey)
      throw new Error(
        "Fleet machine changed before request admission; no operation was sent or locally substituted. Reopen the target catalog.",
      );
    if (invocation.name === "zenx_fleet_shell") {
      if (device.transport !== "https")
        throw new Error(
          "This SSH device does not expose target-owned Fleet shell admission. Use an explicitly paired HTTPS Host with shell capability; raw SSH shell fallback is not supported.",
        );
      if (device.access !== "control" || device.shellEnabled !== true)
        throw new Error(
          "Fleet shell requires separate remote shell opt-in and a fresh control grant. Review the device and pair again with shell enabled.",
        );
    }
    if (!fleetTools.has(invocation.name))
      throw new Error("This tool does not support Fleet");
    if (device.access !== "control" && !fleetReadTools.has(invocation.name))
      throw new Error(`Fleet device ${deviceId} is read-only`);
    const { device: _device, ...args } = invocation.arguments;
    const request: FleetRequest = {
      // Old bridges strictly reject v2 before executing their unfenced sends.
      version:
        device.transport !== "https" &&
        invocation.name === "zenx_threads_send" &&
        typeof args.threadId === "string" &&
        args.target === undefined
          ? 2
          : 1,
      name: invocation.name,
      arguments: args,
      callId: invocation.callId,
      ...(invocation.canonicalToolCallId
        ? { canonicalToolCallId: invocation.canonicalToolCallId }
        : {}),
      ...(invocation.threadId ? { threadId: invocation.threadId } : {}),
    };
    if (request.name === "zenx_threads_send" && args.messageType === undefined)
      request.arguments.messageType = "guidance";
    invocation.signal.throwIfAborted();
    const result =
      device.transport === "https"
        ? await this.#native().invoke(device, request, invocation.signal)
        : await this.transport(device, request, invocation.signal);
    return { device: deviceId, result };
  }
  #native(): NativeFleetPort {
    if (!this.native)
      throw new Error("Fleet native HTTPS service is not attached");
    return this.native;
  }
}

export function sshFleetTransport(
  device: FleetDevice,
  request: FleetRequest,
  signal: AbortSignal,
): Promise<unknown> {
  if (device.transport === "https")
    throw new Error("HTTPS Fleet device cannot use SSH transport");
  // Destination and command come only from user configuration, never tool arguments.
  // SSH owns persistent authentication and host-key verification; no exported Host token.
  const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  return runFleetProcess(
    "ssh",
    [
      "-T",
      "-oBatchMode=yes",
      "-oStrictHostKeyChecking=yes",
      "-oConnectTimeout=10",
      "--",
      device.sshHost,
      device.command.map(quote).join(" "),
    ],
    request,
    signal,
  );
}
export function runFleetProcess(
  command: string,
  args: string[],
  request: FleetRequest,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let done = false;
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const abort = () =>
      finish(
        new Error(
          "Fleet request cancelled; remote admission may be unknown. Inspect the target before retrying.",
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Fleet request timed out; remote admission may be unknown. No automatic retry.",
          ),
        ),
      45_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      finish(new Error("Fleet SSH process could not start")),
    );
    child.stdin.on("error", () =>
      finish(
        new Error("Fleet connection closed; remote admission may be unknown"),
      ),
    );
    child.stdout.on("data", (data: Buffer) => {
      stdout += decoder.write(data);
      if (Buffer.byteLength(stdout) > 1024 * 1024)
        finish(
          new Error(
            "Fleet response exceeds limit; remote admission may be unknown",
          ),
        );
    });
    child.stderr.resume();
    child.on("close", (code) => {
      if (code !== 0)
        return finish(
          new Error(
            `Fleet connection or remote operation failed (exit ${String(code)}); remote admission may be unknown. Check SSH access and the target Host.`,
          ),
        );
      try {
        stdout += decoder.end();
        const response = JSON.parse(stdout) as {
          version?: number;
          ok?: boolean;
          result?: unknown;
          error?: string;
        };
        if (response.version !== 1 || typeof response.ok !== "boolean")
          throw new Error("Invalid response");
        if (!response.ok)
          finish(
            new Error(
              request.version === 2 &&
                response.error === "Invalid Fleet request"
                ? "Target Fleet bridge does not support archive-fenced Thread sends. Update the target bridge and Host before retrying."
                : `Fleet remote error: ${response.error ?? "request failed"}`,
            ),
          );
        else finish(undefined, response.result);
      } catch {
        finish(
          new Error("Invalid Fleet response; remote admission may be unknown"),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

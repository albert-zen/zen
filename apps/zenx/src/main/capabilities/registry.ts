import { randomUUID } from "node:crypto";

import type { ModelTool } from "../../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
} from "../../../../../src/tool.js";
import type {
  RegisteredZenXCapability,
  ZenXCapabilityAuditRecord,
  ZenXCapabilityGrant,
  ZenXCapabilityGrantStore,
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityManifest,
  ZenXCapabilityPackage,
  ZenXCapabilitySnapshot,
  ZenXCapabilityTool,
} from "./types.js";

export const CAPABILITY_RESOURCE_TOOL = "zenx_capability_resource";
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_AUDIT_RECORDS = 100;
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|secret|sessionMaterial|storageState|token)/iu;

export class ZenXCapabilityRegistry implements ZenXCapabilityHost {
  readonly #grantStore: ZenXCapabilityGrantStore;
  readonly #registered = new Map<string, RegisteredZenXCapability>();
  readonly #toolOwners = new Map<
    string,
    { capabilityId: string; tool: ZenXCapabilityTool }
  >();
  readonly #listeners = new Set<(snapshot: ZenXCapabilitySnapshot) => void>();
  readonly #audit: ZenXCapabilityAuditRecord[] = [];
  readonly #discoveryErrors: string[] = [];
  #grants: Record<string, ZenXCapabilityGrant[]> = {};

  constructor(grantStore: ZenXCapabilityGrantStore) {
    this.#grantStore = grantStore;
  }

  async initialize(): Promise<void> {
    this.#grants = await this.#grantStore.load();
  }

  register(
    capabilityPackage: ZenXCapabilityPackage,
    source: "bundled" | "local" = "bundled",
  ): void {
    const manifest = validateManifest(capabilityPackage.manifest);
    if (this.#registered.has(manifest.id)) {
      throw new Error(`Capability ${manifest.id} is already registered`);
    }
    for (const tool of manifest.tools) {
      if (
        tool.name === CAPABILITY_RESOURCE_TOOL ||
        this.#toolOwners.has(tool.name)
      ) {
        throw new Error(`Capability tool ${tool.name} is already registered`);
      }
    }
    this.#registered.set(manifest.id, { package: capabilityPackage, source });
    for (const tool of manifest.tools) {
      this.#toolOwners.set(tool.name, { capabilityId: manifest.id, tool });
    }
    this.#emit();
  }

  async unregister(capabilityId: string): Promise<void> {
    const registered = this.#registered.get(capabilityId);
    if (registered === undefined) return;
    this.#registered.delete(capabilityId);
    for (const tool of registered.package.manifest.tools) {
      this.#toolOwners.delete(tool.name);
    }
    await registered.package.close?.();
    this.#emit();
  }

  recordDiscoveryError(message: string): void {
    this.#discoveryErrors.push(message);
    this.#emit();
  }

  async grant(
    capabilityId: string,
    permissionIds?: readonly string[],
  ): Promise<void> {
    const manifest = this.#requireCapability(capabilityId).package.manifest;
    const selected =
      permissionIds === undefined
        ? manifest.permissions
        : permissionIds.map((permissionId) => {
            const permission = manifest.permissions.find(
              (candidate) => candidate.id === permissionId,
            );
            if (permission === undefined) {
              throw new Error(
                `Capability ${capabilityId} does not request ${permissionId}`,
              );
            }
            return permission;
          });
    const existing = new Map(
      (this.#grants[capabilityId] ?? []).map((grant) => [
        grant.permissionId,
        grant,
      ]),
    );
    for (const permission of selected) {
      existing.set(permission.id, {
        permissionId: permission.id,
        scope: permission.scope,
      });
    }
    this.#grants = {
      ...this.#grants,
      [capabilityId]: [...existing.values()],
    };
    await this.#grantStore.save(this.#grants);
    this.#emit();
  }

  async revoke(
    capabilityId: string,
    permissionIds?: readonly string[],
  ): Promise<void> {
    this.#requireCapability(capabilityId);
    if (permissionIds === undefined) {
      const { [capabilityId]: _removed, ...remaining } = this.#grants;
      this.#grants = remaining;
    } else {
      const revoked = new Set(permissionIds);
      this.#grants = {
        ...this.#grants,
        [capabilityId]: (this.#grants[capabilityId] ?? []).filter(
          (grant) => !revoked.has(grant.permissionId),
        ),
      };
    }
    await this.#grantStore.save(this.#grants);
    this.#emit();
  }

  snapshot(): ZenXCapabilitySnapshot {
    return {
      capabilities: [...this.#registered.values()].map((registered) => {
        const manifest = registered.package.manifest;
        return {
          manifest: {
            ...manifest,
            resources: manifest.resources.map(
              ({ content: _content, ...resource }) => resource,
            ),
          },
          source: registered.source,
          granted: structuredClone(this.#grants[manifest.id] ?? []),
          enabledTools: manifest.tools
            .filter((tool) =>
              this.#hasPermissions(manifest.id, tool.permissions),
            )
            .map((tool) => tool.name),
        };
      }),
      recentInvocations: structuredClone(this.#audit),
      discoveryErrors: [...this.#discoveryErrors],
    };
  }

  hostSnapshot(): ZenXCapabilityHostSnapshot {
    const definitions: ModelTool[] = [];
    const resources: string[] = [];
    for (const registered of this.#registered.values()) {
      const manifest = registered.package.manifest;
      for (const tool of manifest.tools) {
        if (this.#hasPermissions(manifest.id, tool.permissions)) {
          definitions.push({
            name: tool.name,
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
          });
        }
      }
      if (
        manifest.resources.length > 0 &&
        this.#hasPermissions(
          manifest.id,
          manifest.permissions.map((permission) => permission.id),
        )
      ) {
        resources.push(
          ...manifest.resources.map(
            (resource) =>
              `${manifest.id}/${resource.id} (${resource.kind}): ${resource.description}`,
          ),
        );
      }
    }
    if (resources.length > 0) {
      definitions.push({
        name: CAPABILITY_RESOURCE_TOOL,
        description: `Read an installed ZenX capability skill or prompt resource. Available resources: ${resources.join("; ")}`,
        inputSchema: {
          type: "object",
          properties: {
            capabilityId: { type: "string" },
            resourceId: { type: "string" },
          },
          required: ["capabilityId", "resourceId"],
          additionalProperties: false,
        },
      });
    }
    return { definitions };
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const audit = this.#startAudit(invocation);
    try {
      const output =
        invocation.name === CAPABILITY_RESOURCE_TOOL
          ? this.#readResource(invocation.arguments)
          : await this.#executeProvider(invocation);
      invocation.signal.throwIfAborted();
      const result = boundedResult(
        invocation.name,
        output.value,
        output.maxOutputBytes,
      );
      this.#finishAudit(audit, "completed", summarize(result));
      return { output: result, exitCode: 0 };
    } catch (error) {
      const cancelled = invocation.signal.aborted || isAbortError(error);
      this.#finishAudit(
        audit,
        cancelled ? "cancelled" : "failed",
        describeError(error),
      );
      throw error;
    }
  }

  onChange(listener: (snapshot: ZenXCapabilitySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const capabilityId of [...this.#registered.keys()]) {
      await this.unregister(capabilityId);
    }
  }

  async #executeProvider(invocation: ToolInvocation): Promise<{
    value: unknown;
    maxOutputBytes: number;
  }> {
    const owner = this.#toolOwners.get(invocation.name);
    if (owner === undefined) {
      throw new Error(`Unsupported ZenX capability tool: ${invocation.name}`);
    }
    if (!this.#hasPermissions(owner.capabilityId, owner.tool.permissions)) {
      throw new Error(
        `Capability ${owner.capabilityId} is not granted for ${invocation.name}`,
      );
    }
    invocation.signal.throwIfAborted();
    const registered = this.#requireCapability(owner.capabilityId);
    return {
      value: await registered.package.invoke(invocation.name, invocation),
      maxOutputBytes: owner.tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    };
  }

  #readResource(arguments_: Record<string, unknown>): {
    value: unknown;
    maxOutputBytes: number;
  } {
    const capabilityId = requiredString(arguments_, "capabilityId");
    const resourceId = requiredString(arguments_, "resourceId");
    const manifest = this.#requireCapability(capabilityId).package.manifest;
    if (
      !this.#hasPermissions(
        capabilityId,
        manifest.permissions.map((permission) => permission.id),
      )
    ) {
      throw new Error(`Capability ${capabilityId} is not fully granted`);
    }
    const resource = manifest.resources.find(
      (candidate) => candidate.id === resourceId,
    );
    if (resource === undefined) {
      throw new Error(
        `Unknown capability resource ${capabilityId}/${resourceId}`,
      );
    }
    return {
      value: {
        capabilityId,
        resourceId,
        kind: resource.kind,
        title: resource.title,
        content: resource.content,
      },
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    };
  }

  #hasPermissions(capabilityId: string, required: readonly string[]): boolean {
    const granted = new Set(
      (this.#grants[capabilityId] ?? []).map((grant) => grant.permissionId),
    );
    return required.every((permission) => granted.has(permission));
  }

  #requireCapability(capabilityId: string): RegisteredZenXCapability {
    const registered = this.#registered.get(capabilityId);
    if (registered === undefined) {
      throw new Error(`Unknown ZenX capability: ${capabilityId}`);
    }
    return registered;
  }

  #startAudit(invocation: ToolInvocation): ZenXCapabilityAuditRecord {
    const owner = this.#toolOwners.get(invocation.name);
    const record: ZenXCapabilityAuditRecord = {
      id: randomUUID(),
      capabilityId:
        invocation.name === CAPABILITY_RESOURCE_TOOL
          ? String(invocation.arguments.capabilityId ?? "unknown")
          : (owner?.capabilityId ?? "unknown"),
      toolName: invocation.name,
      callId: invocation.callId,
      cwd: invocation.cwd,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#audit.unshift(record);
    this.#audit.splice(MAX_AUDIT_RECORDS);
    this.#emit();
    return record;
  }

  #finishAudit(
    record: ZenXCapabilityAuditRecord,
    status: Exclude<ZenXCapabilityAuditRecord["status"], "running">,
    summary: string,
  ): void {
    record.status = status;
    record.completedAt = new Date().toISOString();
    record.summary = summarize(summary);
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function validateManifest(
  manifest: ZenXCapabilityManifest,
): ZenXCapabilityManifest {
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `Unsupported capability manifest version: ${String(manifest.schemaVersion)}`,
    );
  }
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(manifest.id)) {
    throw new Error(`Invalid capability id: ${manifest.id}`);
  }
  const permissionIds = new Set(
    manifest.permissions.map((permission) => permission.id),
  );
  if (permissionIds.size !== manifest.permissions.length) {
    throw new Error(`Capability ${manifest.id} has duplicate permissions`);
  }
  const toolNames = new Set<string>();
  for (const tool of manifest.tools) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(tool.name)) {
      throw new Error(`Invalid capability tool name: ${tool.name}`);
    }
    if (toolNames.has(tool.name)) {
      throw new Error(
        `Capability ${manifest.id} has duplicate tool ${tool.name}`,
      );
    }
    toolNames.add(tool.name);
    for (const permission of tool.permissions) {
      if (!permissionIds.has(permission)) {
        throw new Error(
          `Tool ${tool.name} requests unknown permission ${permission}`,
        );
      }
    }
  }
  return manifest;
}

function boundedResult(
  toolName: string,
  value: unknown,
  maxBytes: number,
): string {
  const safe = redactSensitive(value);
  const serialized = JSON.stringify({ tool: toolName, result: safe });
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  const budget = Math.max(0, maxBytes - 160);
  const preview = Buffer.from(JSON.stringify(safe), "utf8")
    .subarray(0, budget)
    .toString("utf8");
  return JSON.stringify({
    tool: toolName,
    resultPreview: preview,
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
  });
}

function redactSensitive(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
      .replace(
        /\b((?:api[_-]?key|access[_-]?token|password|secret))=[^&\s]+/giu,
        "$1=[REDACTED]",
      );
  }
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSensitive(child, childKey),
      ]),
    );
  }
  return value;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return candidate;
}

function summarize(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}…`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

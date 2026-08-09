import type { ModelTool } from "../../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
} from "../../../../../src/tool.js";

export const MIN_CAPABILITY_OUTPUT_BYTES = 1024;
export const MAX_CAPABILITY_OUTPUT_BYTES = 1024 * 1024;

export type ZenXCapabilityPermissionScope =
  "browser-session" | "local-device" | "workspace";

export interface ZenXCapabilityPermission {
  id: string;
  title: string;
  description: string;
  scope: ZenXCapabilityPermissionScope;
}

export type ZenXCapabilityInteractionMode =
  "background_safe" | "foreground_required" | "isolated";

export interface ZenXCapabilityTool extends ModelTool {
  permissions: string[];
  interactionMode: ZenXCapabilityInteractionMode;
  capabilities: string[];
  maxOutputBytes?: number;
}

export interface ZenXCapabilityResource {
  id: string;
  kind: "skill" | "prompt";
  title: string;
  description: string;
  content: string;
}

export interface ZenXCapabilityManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  version: string;
  description: string;
  provider: {
    id: string;
    platforms: string[];
    interactionModes: ZenXCapabilityInteractionMode[];
    capabilities: string[];
  };
  permissions: ZenXCapabilityPermission[];
  tools: ZenXCapabilityTool[];
  resources: ZenXCapabilityResource[];
  settings?: Readonly<Record<string, unknown>>;
  ui?: { settingsSection?: string };
}

export interface ZenXCapabilityPackage {
  manifest: ZenXCapabilityManifest;
  invoke(toolName: string, invocation: ToolInvocation): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface ZenXCapabilityGrant {
  permissionId: string;
  scope: ZenXCapabilityPermissionScope;
}

export interface ZenXCapabilityAuditRecord {
  id: string;
  capabilityId: string;
  providerId: string;
  toolName: string;
  callId: string;
  cwd: string;
  interactionMode: ZenXCapabilityInteractionMode;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  summary?: string;
}

export interface ZenXCapabilitySummary {
  manifest: Omit<ZenXCapabilityManifest, "resources"> & {
    resources: Array<Omit<ZenXCapabilityResource, "content">>;
  };
  source: "bundled" | "local";
  available: boolean;
  unavailableReason?: string;
  granted: ZenXCapabilityGrant[];
  enabledTools: string[];
  blockedTools: string[];
}

export interface ZenXCapabilitySnapshot {
  capabilities: ZenXCapabilitySummary[];
  recentInvocations: ZenXCapabilityAuditRecord[];
  discoveryErrors: string[];
}

export interface ZenXCapabilityHostSnapshot {
  definitions: ModelTool[];
}

export interface ZenXCapabilityHost {
  hostSnapshot(): ZenXCapabilityHostSnapshot;
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

export interface ZenXCapabilityGrantStore {
  load(): Promise<Record<string, ZenXCapabilityGrant[]>>;
  save(grants: Readonly<Record<string, ZenXCapabilityGrant[]>>): Promise<void>;
}

export interface RegisteredZenXCapability {
  package: ZenXCapabilityPackage;
  source: "bundled" | "local";
}

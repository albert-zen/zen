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

export interface ZenXPluginSidebarContribution {
  id: string;
  label: string;
  icon: string;
  pageId: string;
  order?: number;
}

export interface ZenXPluginPageContribution {
  id: string;
  title: string;
  route: string;
}

export interface ZenXPluginContributions {
  sidebar?: ZenXPluginSidebarContribution[];
  pages?: ZenXPluginPageContribution[];
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
  contributions?: ZenXPluginContributions;
  settings?: Readonly<Record<string, unknown>>;
  ui?: { settingsSection?: string };
}

export interface ZenXCapabilityPackage {
  manifest: ZenXCapabilityManifest;
  invoke(toolName: string, invocation: ToolInvocation): Promise<unknown>;
  close?(): Promise<void> | void;
}

export type ZenXCapabilityDisposer = () => Promise<void>;

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

export interface ZenXCapabilityScreenshotArtifact {
  artifactPath: string;
  observationId?: string;
  status: "captured" | "fallback";
  reason?: string;
  width: number;
  height: number;
  bytes: number;
  expiresAt: string;
}

export interface ZenXCapabilityProviderDiagnostic {
  capabilityId: string;
  providerId: string;
  status: "available" | "fallback" | "selected" | "unavailable";
  interactionModes: ZenXCapabilityInteractionMode[];
  capabilities: string[];
  executable?: string;
  version?: string;
  integrity?: "verified" | "unverified" | "failed";
  permissionSummary?: string;
  reason?: string;
  sessionMode?: "isolated-session" | "user-session" | "invalid";
}

export interface ZenXCapabilitySummary {
  manifest: Omit<ZenXCapabilityManifest, "resources"> & {
    resources: Array<Omit<ZenXCapabilityResource, "content">>;
  };
  source: "bundled" | "local";
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  granted: ZenXCapabilityGrant[];
  enabledTools: string[];
  blockedTools: string[];
}

export interface ZenXPluginContributionProjection {
  key: string;
  pluginId: string;
}

export interface ZenXPluginSidebarProjection
  extends ZenXPluginSidebarContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginPageProjection
  extends ZenXPluginPageContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginSummary {
  id: string;
  displayName: string;
  version: string;
  source: "bundled" | "local";
  enabled: boolean;
  contributionCount: number;
}

export interface ZenXPluginSnapshot {
  plugins: ZenXPluginSummary[];
  sidebar: ZenXPluginSidebarProjection[];
  pages: ZenXPluginPageProjection[];
}

export interface ZenXCapabilitySnapshot {
  capabilities: ZenXCapabilitySummary[];
  recentInvocations: ZenXCapabilityAuditRecord[];
  /** Renderer-only live projection; it is intentionally absent from canonical Items. */
  currentScreenshot?: ZenXCapabilityScreenshotArtifact;
  providerDiagnostics: ZenXCapabilityProviderDiagnostic[];
  discoveryErrors: string[];
}

export interface ZenXCapabilityHostSnapshot {
  definitions: ModelTool[];
}

export interface ZenXCapabilityHost {
  hostSnapshot(): ZenXCapabilityHostSnapshot;
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

export interface ZenXCapabilityConfigurationStore {
  load(): Promise<ZenXCapabilityConfiguration>;
  save(configuration: ZenXCapabilityConfiguration): Promise<void>;
}

/** Compatibility name for the existing capability-grants persistence seam. */
export type ZenXCapabilityGrantStore = ZenXCapabilityConfigurationStore;

export interface ZenXCapabilityConfiguration {
  grants: Record<string, ZenXCapabilityGrant[]>;
  disabled: string[];
}

export interface RegisteredZenXCapability {
  package: ZenXCapabilityPackage;
  source: "bundled" | "local";
}

import type { ModelTool } from "../../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
} from "../../../../../src/tool.js";
import type {
  PluginStorageMigration,
  PluginStorageValue,
  ZenXPluginHostSdkV1,
} from "../plugin-host-sdk.js";

export const MIN_CAPABILITY_OUTPUT_BYTES = 1024;
export const MAX_CAPABILITY_OUTPUT_BYTES = 1024 * 1024;

export const ZENX_PLUGIN_ICON_NAMES = [
  "clock",
  "layers",
  "plug",
  "settings",
  "terminal",
  "trigger",
  "users",
] as const;
export type ZenXPluginIconName = (typeof ZENX_PLUGIN_ICON_NAMES)[number];

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

export interface ZenXPluginSidebarContribution {
  id: string;
  label: string;
  icon: ZenXPluginIconName;
  pageId: string;
  order?: number;
}

export interface ZenXPluginPageContribution {
  id: string;
  title: string;
  route: string;
  surfaceId?: string;
}

export interface ZenXPluginSubrouteContribution extends ZenXPluginPageContribution {
  pageId: string;
}

export interface ZenXPluginSurfaceContribution {
  id: string;
  title: string;
  surfaceId: string;
  order?: number;
}

export interface ZenXPluginCommandContribution {
  id: string;
  title: string;
  tool: string;
  input?: Readonly<Record<string, unknown>>;
}

export interface ZenXPluginMenuContribution {
  id: string;
  label: string;
  commandId: string;
  location: "page" | "panel" | "settings";
  order?: number;
}

export interface ZenXPluginResultRendererContribution {
  id: string;
  contentType: string;
  surfaceId: string;
}

export interface ZenXPluginContributions {
  sidebar?: ZenXPluginSidebarContribution[];
  pages?: ZenXPluginPageContribution[];
  subroutes?: ZenXPluginSubrouteContribution[];
  settings?: ZenXPluginSurfaceContribution[];
  panels?: ZenXPluginSurfaceContribution[];
  commands?: ZenXPluginCommandContribution[];
  menus?: ZenXPluginMenuContribution[];
  resultRenderers?: ZenXPluginResultRendererContribution[];
}

export interface ZenXPluginUiBundle {
  id: string;
  apiVersion: 1;
  kind: "trusted" | "isolated";
  /** Trusted module registry key, or isolated iframe HTML document. */
  entry: string;
}

export interface ZenXPluginUiSurface {
  id: string;
  bundleId: string;
  exportName: string;
}

export interface ZenXPluginUiManifest {
  bundles: ZenXPluginUiBundle[];
  surfaces: ZenXPluginUiSurface[];
}

export interface ZenXPluginManifestV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  description: string;
  compatibility: ZenXPluginCompatibility;
  runtime: ZenXPluginRuntimeDescriptor;
  mainDocument: string;
  storageVersion?: number;
  provider: {
    id: string;
    platforms: string[];
    interactionModes: ZenXCapabilityInteractionMode[];
    capabilities: string[];
  };
  permissions: ZenXCapabilityPermission[];
  tools: ZenXCapabilityTool[];
  contributions?: ZenXPluginContributions;
  ui?: ZenXPluginUiManifest;
}

export interface ZenXPluginCompatibility {
  zenx: string;
}

export type ZenXPluginRuntimeDescriptor =
  | { type: "bundled"; entry: string }
  | {
      type: "process";
      entry: string;
      args?: string[];
      timeoutMs?: number;
    }
  | {
      type: "http";
      url: string;
      timeoutMs?: number;
    };

export interface ZenXCapabilityPackage {
  manifest: ZenXPluginManifestV2;
  storage?: {
    version: number;
    migrations?: readonly PluginStorageMigration[];
    initialValue?: PluginStorageValue;
  };
  /** Called whenever a v2 bundled runtime is admitted. */
  start?(hostSdk: ZenXPluginHostSdkV1): Promise<void> | void;
  invoke(
    toolName: string,
    invocation: ToolInvocation,
    hostSdk?: ZenXPluginHostSdkV1,
  ): Promise<unknown>;
  close?(): Promise<void> | void;
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

export interface ZenXPluginContributionProjection {
  key: string;
  pluginId: string;
}

export interface ZenXPluginSidebarProjection
  extends ZenXPluginSidebarContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginPageProjection
  extends ZenXPluginPageContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginSubrouteProjection
  extends ZenXPluginSubrouteContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginSurfaceProjection
  extends ZenXPluginSurfaceContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginCommandProjection
  extends ZenXPluginCommandContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginMenuProjection
  extends ZenXPluginMenuContribution, ZenXPluginContributionProjection {}

export interface ZenXPluginResultRendererProjection
  extends
    ZenXPluginResultRendererContribution,
    ZenXPluginContributionProjection {}

export interface ZenXPluginUiBundleProjection
  extends ZenXPluginUiBundle, ZenXPluginContributionProjection {}

export interface ZenXPluginUiSurfaceProjection
  extends ZenXPluginUiSurface, ZenXPluginContributionProjection {}

export interface ZenXPluginSummary {
  id: string;
  displayName: string;
  version: string;
  description?: string;
  compatibility?: string;
  source: "bundled" | "local";
  profileSource?: ZenXPluginProfileSource;
  lifecycle: "installed" | "enabled" | "uninstalled";
  enabled: boolean;
  available: boolean;
  contributionCount: number;
}

export type ZenXPluginProfileSourceMode =
  "bundled" | "npm" | "git" | "tarball" | "local-copy" | "dev-link";

/** User-selected source passed unchanged back through bundled pnpm on reinstall. */
export interface ZenXPluginPackageSource {
  mode: ZenXPluginProfileSourceMode;
  packageSpec: string;
}

/** Exact source and resolution identity committed with a profile generation. */
export interface ZenXPluginProfileSource extends ZenXPluginPackageSource {
  resolvedSpec: string;
  packageName: string;
  packageVersion: string;
}

export interface ZenXPluginSnapshot {
  plugins: ZenXPluginSummary[];
  bundles: ZenXPluginUiBundleProjection[];
  surfaces: ZenXPluginUiSurfaceProjection[];
  sidebar: ZenXPluginSidebarProjection[];
  pages: ZenXPluginPageProjection[];
  subroutes: ZenXPluginSubrouteProjection[];
  settings: ZenXPluginSurfaceProjection[];
  panels: ZenXPluginSurfaceProjection[];
  commands: ZenXPluginCommandProjection[];
  menus: ZenXPluginMenuProjection[];
  resultRenderers?: ZenXPluginResultRendererProjection[];
}

export interface ZenXPluginDiagnostics {
  providerDiagnostics: ZenXCapabilityProviderDiagnostic[];
  discoveryErrors: string[];
}

export type ZenXPostCommitCapabilityRefresh =
  { status: "refreshed" } | { status: "failed"; message: string };

export interface ZenXPluginMutationResult {
  snapshot: ZenXPluginSnapshot;
  capabilityRefresh: ZenXPostCommitCapabilityRefresh;
}

export type ZenXPluginTarballSelectionResult =
  | { canceled: true }
  | {
      canceled: false;
      snapshot: ZenXPluginSnapshot;
      capabilityRefresh: ZenXPostCommitCapabilityRefresh;
    };

export interface ZenXCapabilityHostSnapshot {
  definitions: ModelTool[];
  /** Current v2 discovery catalog projected into the hosted App Server. */
  plugins?: ZenXAvailablePlugin[];
}

export interface ZenXAvailablePlugin {
  id: string;
  name: string;
  description: string;
  status: "enabled";
  mainDocument: string;
  tools: ModelTool[];
}

export interface ZenXCapabilityHost {
  hostSnapshot(): ZenXCapabilityHostSnapshot;
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

export interface ZenXPluginCatalogStore {
  load(): Promise<ZenXPluginCatalogState>;
  save(configuration: ZenXPluginCatalogState): Promise<void>;
}

export interface ZenXPluginCatalogState {
  disabled: string[];
  uninstalled?: string[];
  packages?: Record<string, ZenXPluginPackageDescriptor>;
  profileGeneration?: string;
}

export interface ZenXPluginPackageDescriptor {
  manifest: ZenXPluginManifestV2;
  source: "bundled" | "local";
  profilePackageName?: string;
  profileSource?: ZenXPluginProfileSource;
}

export interface RegisteredZenXCapability {
  package: ZenXCapabilityPackage;
  source: "bundled" | "local";
}

/** Optional ZP3 bridge used by the Catalog to publish/revoke a runtime provider. */
export interface ZenXPluginRuntimeLifecycle {
  stage(
    registration: RegisteredZenXCapability,
    options?: { replaceCurrent?: boolean },
  ): Promise<ZenXPluginRuntimeStage>;
  stop(pluginId: string): Promise<void>;
}

export interface ZenXPluginRuntimeStage {
  publish(): void;
  rollback(): Promise<void>;
}

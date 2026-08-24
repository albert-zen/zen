export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface PluginAttachmentRef {
  readonly type: "attachment";
  readonly sha256: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}

export type PluginUserInput = readonly (
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly attachment: PluginAttachmentRef }
)[];

export interface PluginProject {
  readonly key: string;
  readonly workspace: string;
  readonly configured: boolean;
  readonly isDefault: boolean;
  readonly threadIds: readonly string[];
}

export interface PluginCanonicalItem {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly createdAt: string;
  readonly type: string;
}

export type PluginStorageValue = Readonly<Record<string, unknown>>;

export interface PluginStorageMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(
    value: PluginStorageValue,
  ): PluginStorageValue | Promise<PluginStorageValue>;
}

export interface ZenXPluginHostSdkV1 {
  readonly version: 1;
  readonly pluginId: string;
  readonly query: {
    readonly projects: {
      list(): Promise<readonly PluginProject[]>;
    };
  };
  readonly actions: {
    readonly threads: {
      startTurn(input: {
        threadId: string;
        input: string | PluginUserInput;
      }): Promise<{
        threadId: string;
        turnId: string;
        items: readonly PluginCanonicalItem[];
      }>;
    };
  };
  readonly ui: {
    readonly handles: { read(handleId: string): Promise<unknown> };
    readonly commands: {
      execute(commandId: string, input?: unknown): Promise<unknown>;
    };
  };
  readonly storage: {
    readonly version: number;
    get(): Promise<PluginStorageValue>;
    set(value: PluginStorageValue): Promise<void>;
  };
}

export interface PluginUiSdkV1 {
  readonly version: 1;
  readonly pluginId: string;
  readonly theme: "light" | "dark";
  readonly context: Readonly<Record<string, unknown>>;
  readonly navigation: { navigate(route: string): void };
  readonly handles: { read(handleId: string): Promise<unknown> };
  readonly commands: {
    execute(commandId: string, input?: unknown): Promise<unknown>;
  };
}

export type PluginHostSdkRequest =
  | { operation: "query.projects.list" }
  | { operation: "storage.get" }
  | { operation: "storage.set"; value: PluginStorageValue }
  | {
      operation: "actions.threads.startTurn";
      threadId: string;
      input: string | PluginUserInput;
    }
  | { operation: "ui.handles.read"; handleId: string }
  | { operation: "ui.commands.execute"; commandId: string; input?: unknown };

export type ZenXPluginInteractionMode =
  "background_safe" | "foreground_required" | "isolated";

export type ZenXPluginPermissionScope =
  "browser-session" | "local-device" | "workspace";

export interface ZenXPluginPermission {
  id: string;
  title: string;
  description: string;
  scope: ZenXPluginPermissionScope;
}

export interface ZenXPluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions: string[];
  interactionMode: ZenXPluginInteractionMode;
  capabilities: string[];
  maxOutputBytes?: number;
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

export interface ZenXPluginContributions {
  sidebar?: Array<{
    id: string;
    label: string;
    icon:
      | "clock"
      | "layers"
      | "plug"
      | "settings"
      | "terminal"
      | "trigger"
      | "users";
    pageId: string;
    order?: number;
  }>;
  pages?: Array<{
    id: string;
    title: string;
    route: string;
    surfaceId?: string;
  }>;
  subroutes?: Array<{
    id: string;
    title: string;
    route: string;
    surfaceId?: string;
    pageId: string;
  }>;
  settings?: Array<{
    id: string;
    title: string;
    surfaceId: string;
    order?: number;
  }>;
  panels?: Array<{
    id: string;
    title: string;
    surfaceId: string;
    order?: number;
  }>;
  commands?: Array<{
    id: string;
    title: string;
    tool: string;
    input?: Readonly<Record<string, unknown>>;
  }>;
  menus?: Array<{
    id: string;
    label: string;
    commandId: string;
    location: "page" | "panel" | "settings";
    order?: number;
  }>;
  resultRenderers?: Array<{
    id: string;
    contentType: string;
    surfaceId: string;
  }>;
}

export type ZenXPluginRuntimeDescriptor =
  | { type: "bundled"; entry: string }
  | { type: "process"; entry: string; args?: string[]; timeoutMs?: number }
  | { type: "http"; url: string; timeoutMs?: number };

export interface ZenXPluginManifestV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  description: string;
  compatibility: { zenx: string };
  runtime: ZenXPluginRuntimeDescriptor;
  mainDocument: string;
  storageVersion?: number;
  provider: {
    id: string;
    platforms: string[];
    interactionModes: ZenXPluginInteractionMode[];
    capabilities: string[];
  };
  permissions: ZenXPluginPermission[];
  tools: ZenXPluginTool[];
  contributions?: ZenXPluginContributions;
  ui?: { bundles: ZenXPluginUiBundle[]; surfaces: ZenXPluginUiSurface[] };
}

export interface PluginRuntimeInvocationRequest {
  version: 1;
  hostSdkVersion: 1;
  type: "invoke";
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  context: { callId: string; cwd: string };
}

export type PluginRuntimeRequest =
  | PluginRuntimeInvocationRequest
  | { version: 1; type: "cancel"; id: string }
  | { version: 1; type: "close" }
  | {
      version: 1;
      hostSdkVersion: 1;
      type: "host_result";
      id: string;
      invocationId: string;
      result?: unknown;
      error?: string;
    };

export type PluginRuntimeResponse =
  | {
      version: 1;
      type: "ready";
      pluginId: string;
      packageVersion: string;
    }
  | {
      version: 1;
      type: "result";
      id: string;
      result: {
        output: string;
        exitCode: number;
        contentType?: string;
        structuredContent?: JsonValue;
      };
    }
  | { version: 1; type: "error"; id: string; message: string }
  | {
      version: 1;
      hostSdkVersion: 1;
      type: "host_request";
      id: string;
      invocationId: string;
      request: PluginHostSdkRequest;
    };

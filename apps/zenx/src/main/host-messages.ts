import {
  validateBoardToolRequest,
  type BoardToolRequest,
} from "../board-host.js";
import type { ToolExecutionResult } from "../../../../src/tool.js";
import {
  isBrowserModelRoute,
  isBrowserModelTargets,
  isBrowserSidebarTargets,
  type BrowserModelRoute,
  type BrowserModelTargets,
} from "./capabilities/model-browser-metadata.js";
import { validateModelRequestDebugCommand } from "../../../../apps/cli/src/model-request-debug.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
} from "../../../../apps/cli/src/model-request-debug-types.js";
import type { ShellPanelRequest, ShellPanelResult } from "../shell-panel.js";
import { validateShellPanelRequest } from "../shell-panel.js";
import type { ZenHostOptions } from "../../../../apps/cli/src/host.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../src/thread-summary.js";
import { isNativeThreadSummary } from "../../../../src/thread-summary.js";
import type { ZenXCapabilityGenerationSnapshot } from "./capabilities/types.js";
import type {
  CanonicalItem,
  JsonValue,
  UserInput,
} from "../../../../src/item.js";
import { decodeCanonicalItem } from "../../../../src/item.js";
import {
  isModelUsageProjection,
  type ModelUsageProjection,
} from "../../../../src/model-usage.js";
import {
  isAttachmentRef,
  type ZenXThreadAttachmentProjection,
} from "./image-attachments.js";
import type { HostActivitySnapshot } from "../../../../src/app-server.js";

export type ZenXHostConfig = Omit<
  ZenHostOptions,
  | "journal"
  | "threadMetadata"
  | "threadSummaryProjection"
  | "toolDefinitionProjection"
  | "toolOutputSpool"
  | "codeRuntimeOptions"
  | "onToolPresentationWarning"
> & {
  /** Durable configuration revision loaded by this process at startup. */
  configurationRevision?: number;
  /** Serializable containment limits only; the child Host owns its exact Worker URL. */
  codeRuntimeOptions?: Omit<
    NonNullable<ZenHostOptions["codeRuntimeOptions"]>,
    "workerUrl"
  >;
};

export interface HostConfigurationCandidate {
  processEpoch: string;
  candidateToken: string;
  revision: number;
  pendingRestart: string[];
}

export interface HostConfigurationCurrent {
  processEpoch: string;
  revision: number;
  pendingRestart: string[];
  threadStartDefaults?: import("../../../../src/app-server.js").AppServerDefaults;
}

export type ZenXSingleProviderHostConfig = ZenXHostConfig &
  Required<Pick<ZenXHostConfig, "model" | "provider">>;

export type HostCommand =
  | { type: "board-tool/request"; requestId: string; input: BoardToolRequest }
  | { type: "board-tool/cancel"; requestId: string }
  | { type: "board-tool/owner-result"; requestId: string; error?: string }
  | {
      type: "model-debug/request";
      requestId: string;
      input: ModelRequestDebugCommand;
    }
  | { type: "shell-panel/request"; requestId: string; input: ShellPanelRequest }
  | {
      type: "fleet/control";
      requestId: string;
      action: string;
      input?: unknown;
    }
  | {
      type: "fleet/room-result";
      requestId: string;
      result?: unknown;
      error?: string;
    }
  | { type: "fleet/room-event"; roomId: string; threadId: string }
  | {
      type: "start";
      config: ZenXHostConfig;
      bearerToken: string;
      listen?: string;
      capabilities: ZenXCapabilityGenerationSnapshot;
    }
  | { type: "shutdown" }
  | {
      type: "configuration/prepare";
      requestId: string;
      candidateToken: string;
      config: ZenXHostConfig;
      revision: number;
    }
  | {
      type: "configuration/publish";
      requestId: string;
      candidate: HostConfigurationCandidate;
    }
  | {
      type: "configuration/discard";
      requestId: string;
      candidate: HostConfigurationCandidate;
    }
  | { type: "configuration/current"; requestId: string }
  | { type: "maintenance/try-begin"; requestId: string }
  | { type: "maintenance/end"; maintenanceToken: string }
  | {
      type: "thread-summary/list";
      requestId: string;
      options: ThreadSummaryListOptions;
    }
  | {
      type: "thread-attachments/read";
      requestId: string;
      threadId: string;
    }
  | { type: "thread-usage/read"; requestId: string; threadId: string }
  | {
      type: "plugin-turn/start";
      requestId: string;
      threadId: string;
      input: string | UserInput;
    }
  | {
      type: "capabilities/replace";
      requestId: string;
      targetPluginId?: string;
      capabilities: ZenXCapabilityGenerationSnapshot;
    }
  | { type: "capabilities/current"; requestId: string }
  | CapabilityResultCommand;

export interface CapabilityResultCommand {
  browserModelTargets?: BrowserModelTargets;
  browserSidebarTargets?: BrowserModelRoute[];
  type: "capability/result";
  invocationId: string;
  generationToken: string;
  output?: string;
  exitCode?: number;
  contentType?: string;
  structuredContent?: JsonValue;
  sourceTruncated?: boolean;
  error?: string;
}

export type HostEvent =
  | { type: "board-tool/check-owner"; requestId: string }
  | {
      type: "board-tool/result";
      requestId: string;
      result?: ToolExecutionResult;
      error?: string;
      /** Local UI diagnostic only, never model or authority data. */
      errorDetail?: string;
    }
  | {
      type: "model-debug/result";
      requestId: string;
      result?: ModelRequestDebugResult;
      error?: string;
    }
  | {
      type: "shell-panel/result";
      requestId: string;
      result?: ShellPanelResult;
      error?: string;
    }
  | {
      type: "fleet/result";
      requestId: string;
      result?: unknown;
      error?: string;
    }
  | {
      type: "fleet/room-request";
      requestId: string;
      operation: "list" | "read" | "post" | "trigger";
      params: {
        workspaceId: string;
        workspaceCwd: string;
        deviceId: string;
        roomId?: string;
        triggerId?: string;
        threadId?: string;
        text?: string;
        clientId?: string;
      };
    }
  | { type: "ready"; url: string; processEpoch: string }
  | { type: "error"; message: string }
  | {
      type: "configuration/prepared";
      requestId: string;
      candidate?: HostConfigurationCandidate;
      error?: string;
    }
  | {
      type: "configuration/published";
      requestId: string;
      current?: HostConfigurationCurrent;
      error?: string;
    }
  | {
      type: "configuration/discarded";
      requestId: string;
      error?: string;
    }
  | {
      type: "configuration/current";
      requestId: string;
      current?: HostConfigurationCurrent;
      error?: string;
    }
  | {
      type: "maintenance/result";
      requestId: string;
      accepted: boolean;
      activity: HostActivitySnapshot;
    }
  | {
      type: "thread-summary/result";
      requestId: string;
      summaries: NativeThreadSummary[];
      error?: never;
    }
  | {
      type: "thread-attachments/result";
      requestId: string;
      attachments: ZenXThreadAttachmentProjection;
      error?: never;
    }
  | {
      type: "thread-usage/result";
      requestId: string;
      usage: ModelUsageProjection;
      error?: never;
    }
  | {
      type: "thread-usage/result";
      requestId: string;
      usage?: never;
      error: string;
    }
  | {
      type: "plugin-turn/result";
      requestId: string;
      threadId: string;
      turnId: string;
      items: CanonicalItem[];
      error?: never;
    }
  | {
      type: "plugin-turn/result";
      requestId: string;
      threadId?: never;
      turnId?: never;
      items?: never;
      error: string;
    }
  | {
      type: "thread-attachments/result";
      requestId: string;
      attachments?: never;
      error: string;
    }
  | {
      type: "thread-summary/result";
      requestId: string;
      summaries?: never;
      error: string;
    }
  | {
      type: "capability/invoke";
      browserModelRoute?: BrowserModelRoute;
      browserSidebarTargets?: BrowserModelRoute[];
      /** Host-minted execution-target transport; never tool-argument provenance. */
      targetRoute?: true;
      invocationId: string;
      generationToken: string;
      invocation: {
        approvalScope?: import("../../../../src/tool.js").ToolApprovalScope;
        callId: string;
        canonicalToolCallId?: string;
        threadId?: string;
        task?: {
          waitForCompletion?: boolean;
          yieldTimeMs?: number;
          timeoutMs?: number;
          previewBytes?: number;
        };
        name: string;
        arguments: Record<string, unknown>;
        cwd: string;
      };
    }
  | {
      type: "capability/cancel";
      invocationId: string;
      generationToken: string;
    }
  | { type: "capabilities/released"; generationToken: string }
  | {
      type: "capabilities/replaced";
      requestId: string;
      generationToken: string;
      error?: string;
    }
  | {
      type: "capabilities/current";
      requestId: string;
      generationToken: string;
      error?: never;
    }
  | {
      type: "capabilities/current";
      requestId: string;
      generationToken?: never;
      error: string;
    };

export function isHostCommand(value: unknown): value is HostCommand {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const fleet = value as Record<string, unknown>;
  if (fleet.type === "board-tool/cancel")
    return typeof fleet.requestId === "string";
  if (fleet.type === "board-tool/owner-result")
    return (
      typeof fleet.requestId === "string" &&
      (fleet.error === undefined || typeof fleet.error === "string")
    );
  if (fleet.type === "board-tool/request") {
    try {
      validateBoardToolRequest(fleet.input);
      return typeof fleet.requestId === "string";
    } catch {
      return false;
    }
  }
  if (fleet.type === "model-debug/request") {
    try {
      validateModelRequestDebugCommand(fleet.input);
      return typeof fleet.requestId === "string";
    } catch {
      return false;
    }
  }
  if (fleet.type === "shell-panel/request") {
    try {
      validateShellPanelRequest(fleet.input);
      return typeof fleet.requestId === "string";
    } catch {
      return false;
    }
  }
  if (fleet.type === "fleet/control")
    return (
      typeof fleet.requestId === "string" && typeof fleet.action === "string"
    );
  if (fleet.type === "fleet/room-result")
    return (
      typeof fleet.requestId === "string" &&
      (fleet.error === undefined || typeof fleet.error === "string")
    );
  if (fleet.type === "fleet/room-event")
    return (
      typeof fleet.roomId === "string" && typeof fleet.threadId === "string"
    );
  const command = value as {
    browserModelTargets?: unknown;
    browserSidebarTargets?: unknown;
    type?: unknown;
    requestId?: unknown;
    options?: unknown;
    threadId?: unknown;
    targetPluginId?: unknown;
    input?: unknown;
    capabilities?: unknown;
    invocationId?: unknown;
    generationToken?: unknown;
    candidate?: unknown;
    candidateToken?: unknown;
    config?: unknown;
    revision?: unknown;
    maintenanceToken?: unknown;
  };
  const type = command.type;
  return (
    (type === "start" && isCapabilityHostSnapshot(command.capabilities)) ||
    type === "shutdown" ||
    (type === "configuration/prepare" &&
      typeof command.requestId === "string" &&
      typeof command.candidateToken === "string" &&
      isZenXHostConfig(command.config) &&
      isConfigurationRevision(command.revision)) ||
    (type === "configuration/publish" &&
      typeof command.requestId === "string" &&
      isHostConfigurationCandidate(command.candidate)) ||
    (type === "configuration/discard" &&
      typeof command.requestId === "string" &&
      isHostConfigurationCandidate(command.candidate)) ||
    (type === "configuration/current" &&
      typeof command.requestId === "string") ||
    (type === "maintenance/try-begin" &&
      typeof command.requestId === "string") ||
    (type === "maintenance/end" &&
      typeof command.maintenanceToken === "string") ||
    (type === "capability/result" &&
      (command.browserModelTargets === undefined ||
        isBrowserModelTargets(command.browserModelTargets)) &&
      (command.browserSidebarTargets === undefined ||
        isBrowserSidebarTargets(command.browserSidebarTargets)) &&
      typeof command.invocationId === "string" &&
      typeof command.generationToken === "string") ||
    (type === "capabilities/replace" &&
      typeof command.requestId === "string" &&
      (command.targetPluginId === undefined ||
        typeof command.targetPluginId === "string") &&
      isCapabilityHostSnapshot(command.capabilities)) ||
    (type === "capabilities/current" &&
      typeof command.requestId === "string") ||
    (type === "thread-attachments/read" &&
      typeof command.requestId === "string" &&
      typeof command.threadId === "string") ||
    (type === "thread-usage/read" &&
      typeof command.requestId === "string" &&
      typeof command.threadId === "string") ||
    (type === "plugin-turn/start" &&
      typeof command.requestId === "string" &&
      typeof command.threadId === "string" &&
      (typeof command.input === "string" || Array.isArray(command.input))) ||
    (type === "thread-summary/list" &&
      typeof command.requestId === "string" &&
      isThreadSummaryListOptions(command.options))
  );
}

function isThreadSummaryListOptions(
  value: unknown,
): value is ThreadSummaryListOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, entry]) => key === "archived" && typeof entry === "boolean",
    )
  );
}

export function isHostEvent(value: unknown): value is HostEvent {
  try {
    return isHostEventUnsafe(value);
  } catch {
    return false;
  }
}

function isHostEventUnsafe(value: unknown): value is HostEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const fleet = value as Record<string, unknown>;
  if (fleet.type === "board-tool/check-owner")
    return typeof fleet.requestId === "string";
  if (fleet.type === "board-tool/result")
    return (
      typeof fleet.requestId === "string" &&
      (fleet.error !== undefined
        ? typeof fleet.error === "string" &&
          fleet.error.length > 0 &&
          (fleet.errorDetail === undefined ||
            typeof fleet.errorDetail === "string") &&
          fleet.result === undefined
        : fleet.errorDetail === undefined &&
          typeof fleet.result === "object" &&
          fleet.result !== null &&
          typeof (fleet.result as Record<string, unknown>).output ===
            "string" &&
          Number.isSafeInteger(
            (fleet.result as Record<string, unknown>).exitCode,
          ))
    );
  if (fleet.type === "model-debug/result")
    return (
      typeof fleet.requestId === "string" &&
      (fleet.error === undefined || typeof fleet.error === "string")
    );
  if (fleet.type === "shell-panel/result")
    return (
      typeof fleet.requestId === "string" &&
      (fleet.error === undefined || typeof fleet.error === "string")
    );
  if (fleet.type === "fleet/result")
    return (
      typeof fleet.requestId === "string" &&
      (fleet.error === undefined || typeof fleet.error === "string")
    );
  if (fleet.type === "fleet/room-request") {
    const params = fleet.params as Record<string, unknown> | undefined;
    return (
      typeof fleet.requestId === "string" &&
      ["list", "read", "post", "trigger"].includes(fleet.operation as string) &&
      !!params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      typeof params.workspaceId === "string" &&
      typeof params.workspaceCwd === "string" &&
      typeof params.deviceId === "string" &&
      (params.roomId === undefined || typeof params.roomId === "string") &&
      (params.triggerId === undefined ||
        typeof params.triggerId === "string") &&
      (params.threadId === undefined || typeof params.threadId === "string") &&
      (params.text === undefined || typeof params.text === "string") &&
      (params.clientId === undefined || typeof params.clientId === "string")
    );
  }
  const event = value as {
    browserModelRoute?: unknown;
    browserSidebarTargets?: unknown;
    type?: unknown;
    url?: unknown;
    message?: unknown;
    invocationId?: unknown;
    invocation?: unknown;
    targetRoute?: unknown;
    generationToken?: unknown;
    requestId?: unknown;
    summaries?: unknown;
    error?: unknown;
    attachments?: unknown;
    usage?: unknown;
    threadId?: unknown;
    turnId?: unknown;
    items?: unknown;
    processEpoch?: unknown;
    candidate?: unknown;
    current?: unknown;
    accepted?: unknown;
    activity?: unknown;
  };
  const hasSummaries = Object.prototype.hasOwnProperty.call(event, "summaries");
  const hasError = Object.prototype.hasOwnProperty.call(event, "error");
  const hasAttachments = Object.prototype.hasOwnProperty.call(
    event,
    "attachments",
  );
  const hasUsage = Object.prototype.hasOwnProperty.call(event, "usage");
  const hasCandidate = Object.prototype.hasOwnProperty.call(event, "candidate");
  const hasCurrent = Object.prototype.hasOwnProperty.call(event, "current");
  return (
    (event.type === "ready" &&
      typeof event.url === "string" &&
      typeof event.processEpoch === "string") ||
    (event.type === "error" && typeof event.message === "string") ||
    (event.type === "configuration/prepared" &&
      typeof event.requestId === "string" &&
      ((hasCandidate &&
        !hasError &&
        isHostConfigurationCandidate(event.candidate)) ||
        (!hasCandidate && hasError && typeof event.error === "string"))) ||
    (event.type === "configuration/published" &&
      typeof event.requestId === "string" &&
      ((hasCurrent && !hasError && isHostConfigurationCurrent(event.current)) ||
        (!hasCurrent && hasError && typeof event.error === "string"))) ||
    (event.type === "configuration/discarded" &&
      typeof event.requestId === "string" &&
      ((!hasError && event.error === undefined) ||
        (hasError && typeof event.error === "string"))) ||
    (event.type === "configuration/current" &&
      typeof event.requestId === "string" &&
      ((hasCurrent && !hasError && isHostConfigurationCurrent(event.current)) ||
        (!hasCurrent && hasError && typeof event.error === "string"))) ||
    (event.type === "maintenance/result" &&
      typeof event.requestId === "string" &&
      typeof event.accepted === "boolean" &&
      isHostActivitySnapshot(event.activity)) ||
    (event.type === "capabilities/replaced" &&
      typeof event.requestId === "string" &&
      typeof event.generationToken === "string" &&
      (event.error === undefined || typeof event.error === "string")) ||
    (event.type === "capabilities/current" &&
      typeof event.requestId === "string" &&
      ((typeof event.generationToken === "string" && !hasError) ||
        (event.generationToken === undefined &&
          hasError &&
          typeof event.error === "string"))) ||
    (event.type === "capabilities/released" &&
      typeof event.generationToken === "string") ||
    (event.type === "thread-attachments/result" &&
      typeof event.requestId === "string" &&
      ((hasAttachments &&
        !hasError &&
        isThreadAttachmentProjection(event.attachments)) ||
        (!hasAttachments && hasError && typeof event.error === "string"))) ||
    (event.type === "thread-usage/result" &&
      typeof event.requestId === "string" &&
      ((hasUsage && !hasError && isModelUsageProjection(event.usage)) ||
        (!hasUsage && hasError && typeof event.error === "string"))) ||
    (event.type === "plugin-turn/result" &&
      typeof event.requestId === "string" &&
      ((Array.isArray(event.items) &&
        event.items.every(isCanonicalItem) &&
        typeof event.threadId === "string" &&
        typeof event.turnId === "string" &&
        !hasError) ||
        (!Object.hasOwn(event, "items") &&
          hasError &&
          typeof event.error === "string"))) ||
    (event.type === "thread-summary/result" &&
      typeof event.requestId === "string" &&
      ((hasSummaries &&
        !hasError &&
        Array.isArray(event.summaries) &&
        event.summaries.every(isNativeThreadSummary)) ||
        (!hasSummaries && hasError && typeof event.error === "string"))) ||
    ((event.type === "capability/invoke" ||
      event.type === "capability/cancel") &&
      typeof event.invocationId === "string" &&
      typeof event.generationToken === "string" &&
      (event.type !== "capability/invoke" ||
        ((event.browserModelRoute === undefined ||
          isBrowserModelRoute(event.browserModelRoute)) &&
          (event.browserSidebarTargets === undefined ||
            isBrowserSidebarTargets(event.browserSidebarTargets)))) &&
      (event.type !== "capability/invoke" ||
        event.targetRoute === undefined ||
        event.targetRoute === true))
  );
}

function isZenXHostConfig(value: unknown): value is ZenXHostConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigurationRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isHostConfigurationCandidate(
  value: unknown,
): value is HostConfigurationCandidate {
  return (
    isHostConfigurationCurrent(value) &&
    typeof (value as { candidateToken?: unknown }).candidateToken === "string"
  );
}

function isHostConfigurationCurrent(
  value: unknown,
): value is HostConfigurationCurrent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { processEpoch?: unknown }).processEpoch === "string" &&
    isConfigurationRevision((value as { revision?: unknown }).revision) &&
    Array.isArray((value as { pendingRestart?: unknown }).pendingRestart) &&
    (value as { pendingRestart: unknown[] }).pendingRestart.every(
      (domain) => typeof domain === "string",
    ) &&
    ((value as HostConfigurationCurrent).threadStartDefaults === undefined ||
      (typeof (value as HostConfigurationCurrent).threadStartDefaults
        ?.providerProfileId === "string" &&
        typeof (value as HostConfigurationCurrent).threadStartDefaults
          ?.modelId === "string" &&
        typeof (value as HostConfigurationCurrent).threadStartDefaults
          ?.sandbox === "string" &&
        typeof (value as HostConfigurationCurrent).threadStartDefaults
          ?.approvalPolicy === "string"))
  );
}

function isHostActivitySnapshot(value: unknown): value is HostActivitySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const activity = value as {
    acceptingRootOperations?: unknown;
    rootOperations?: unknown;
    activeToolTasks?: unknown;
  };
  return (
    typeof activity.acceptingRootOperations === "boolean" &&
    Number.isSafeInteger(activity.activeToolTasks) &&
    (activity.activeToolTasks as number) >= 0 &&
    Array.isArray(activity.rootOperations) &&
    activity.rootOperations.every(isHostOperation)
  );
}

function isHostOperation(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const operation = value as { kind?: unknown; label?: unknown };
  return (
    (operation.kind === "turn" ||
      operation.kind === "compaction" ||
      operation.kind === "provider" ||
      operation.kind === "tool" ||
      operation.kind === "plugin" ||
      operation.kind === "other") &&
    (operation.label === undefined || typeof operation.label === "string")
  );
}

function isCanonicalItem(value: unknown): value is CanonicalItem {
  try {
    decodeCanonicalItem(value);
    return true;
  } catch {
    return false;
  }
}

function isCapabilityHostSnapshot(
  value: unknown,
): value is ZenXCapabilityGenerationSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { definitions?: unknown }).definitions) &&
    ((value as { remoteToolNames?: unknown }).remoteToolNames === undefined ||
      (Array.isArray(
        (value as { remoteToolNames?: unknown }).remoteToolNames,
      ) &&
        (value as { remoteToolNames: unknown[] }).remoteToolNames.every(
          (name) =>
            typeof name === "string" &&
            (value as { definitions: unknown[] }).definitions.some(
              (definition) =>
                typeof definition === "object" &&
                definition !== null &&
                (definition as { name?: unknown }).name === name,
            ),
        ))) &&
    typeof (value as { generationToken?: unknown }).generationToken ===
      "string" &&
    ((value as { plugins?: unknown }).plugins === undefined ||
      Array.isArray((value as { plugins?: unknown }).plugins)) &&
    ((value as { pluginCatalogAvailable?: unknown }).pluginCatalogAvailable ===
      undefined ||
      typeof (value as { pluginCatalogAvailable?: unknown })
        .pluginCatalogAvailable === "boolean") &&
    ((value as { pluginReadiness?: unknown }).pluginReadiness === undefined ||
      (Array.isArray(
        (value as { pluginReadiness?: unknown }).pluginReadiness,
      ) &&
        (value as { pluginReadiness: unknown[] }).pluginReadiness.every(
          (entry) => {
            if (typeof entry !== "object" || entry === null) return false;
            const summary = entry as Record<string, unknown>;
            return (
              typeof summary.id === "string" &&
              typeof summary.displayName === "string" &&
              ["installed", "enabled", "uninstalled"].includes(
                String(summary.lifecycle),
              ) &&
              typeof summary.enabled === "boolean" &&
              typeof summary.available === "boolean"
            );
          },
        )))
  );
}

function isThreadAttachmentProjection(
  value: unknown,
): value is ZenXThreadAttachmentProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  try {
    return Object.values(value).every(
      (attachments) =>
        Array.isArray(attachments) && attachments.every(isAttachmentRef),
    );
  } catch {
    return false;
  }
}

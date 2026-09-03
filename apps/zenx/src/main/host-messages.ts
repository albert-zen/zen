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
  /** Serializable containment limits only; the child Host owns its exact Worker URL. */
  codeRuntimeOptions?: Omit<
    NonNullable<ZenHostOptions["codeRuntimeOptions"]>,
    "workerUrl"
  >;
};

export type ZenXSingleProviderHostConfig = ZenXHostConfig &
  Required<Pick<ZenXHostConfig, "model" | "provider">>;

export type HostCommand =
  | {
      type: "start";
      config: ZenXHostConfig;
      bearerToken: string;
      listen?: string;
      capabilities: ZenXCapabilityGenerationSnapshot;
    }
  | { type: "shutdown" }
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
  | { type: "ready"; url: string }
  | { type: "error"; message: string }
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
      invocationId: string;
      generationToken: string;
      invocation: {
        callId: string;
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
  const command = value as {
    type?: unknown;
    requestId?: unknown;
    options?: unknown;
    threadId?: unknown;
    targetPluginId?: unknown;
    input?: unknown;
    capabilities?: unknown;
    invocationId?: unknown;
    generationToken?: unknown;
  };
  const type = command.type;
  return (
    (type === "start" && isCapabilityHostSnapshot(command.capabilities)) ||
    type === "shutdown" ||
    (type === "capability/result" &&
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
  const event = value as {
    type?: unknown;
    url?: unknown;
    message?: unknown;
    invocationId?: unknown;
    invocation?: unknown;
    generationToken?: unknown;
    requestId?: unknown;
    summaries?: unknown;
    error?: unknown;
    attachments?: unknown;
    usage?: unknown;
    threadId?: unknown;
    turnId?: unknown;
    items?: unknown;
  };
  const hasSummaries = Object.prototype.hasOwnProperty.call(event, "summaries");
  const hasError = Object.prototype.hasOwnProperty.call(event, "error");
  const hasAttachments = Object.prototype.hasOwnProperty.call(
    event,
    "attachments",
  );
  const hasUsage = Object.prototype.hasOwnProperty.call(event, "usage");
  return (
    (event.type === "ready" && typeof event.url === "string") ||
    (event.type === "error" && typeof event.message === "string") ||
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
      typeof event.generationToken === "string")
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
    typeof (value as { generationToken?: unknown }).generationToken ===
      "string" &&
    ((value as { plugins?: unknown }).plugins === undefined ||
      Array.isArray((value as { plugins?: unknown }).plugins))
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

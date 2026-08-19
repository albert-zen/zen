import type { ZenHostOptions } from "../../../../apps/cli/src/host.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../src/thread-summary.js";
import { isNativeThreadSummary } from "../../../../src/thread-summary.js";
import type { ZenXCapabilityHostSnapshot } from "./capabilities/types.js";

export type ZenXHostConfig = Omit<
  ZenHostOptions,
  "journal" | "threadMetadata" | "threadSummaryProjection"
>;

export type HostCommand =
  | {
      type: "start";
      config: ZenXHostConfig;
      bearerToken: string;
      capabilities: ZenXCapabilityHostSnapshot;
    }
  | { type: "shutdown" }
  | {
      type: "thread-summary/list";
      requestId: string;
      options: ThreadSummaryListOptions;
    }
  | CapabilityResultCommand;

export interface CapabilityResultCommand {
  type: "capability/result";
  invocationId: string;
  output?: string;
  exitCode?: number;
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
      type: "thread-summary/result";
      requestId: string;
      summaries?: never;
      error: string;
    }
  | {
      type: "capability/invoke";
      invocationId: string;
      invocation: {
        callId: string;
        name: string;
        arguments: Record<string, unknown>;
        cwd: string;
      };
    }
  | { type: "capability/cancel"; invocationId: string };

export function isHostCommand(value: unknown): value is HostCommand {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const command = value as {
    type?: unknown;
    requestId?: unknown;
    options?: unknown;
  };
  const type = command.type;
  return (
    type === "start" ||
    type === "shutdown" ||
    type === "capability/result" ||
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
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const event = value as {
    type?: unknown;
    url?: unknown;
    message?: unknown;
    invocationId?: unknown;
    invocation?: unknown;
    requestId?: unknown;
    summaries?: unknown;
    error?: unknown;
  };
  const hasSummaries = Object.prototype.hasOwnProperty.call(event, "summaries");
  const hasError = Object.prototype.hasOwnProperty.call(event, "error");
  return (
    (event.type === "ready" && typeof event.url === "string") ||
    (event.type === "error" && typeof event.message === "string") ||
    (event.type === "thread-summary/result" &&
      typeof event.requestId === "string" &&
      ((hasSummaries &&
        !hasError &&
        Array.isArray(event.summaries) &&
        event.summaries.every(isNativeThreadSummary)) ||
        (!hasSummaries && hasError && typeof event.error === "string"))) ||
    ((event.type === "capability/invoke" ||
      event.type === "capability/cancel") &&
      typeof event.invocationId === "string")
  );
}

import type { ZenHostOptions } from "../../../../apps/cli/src/host.js";
import type { ZenXCapabilityHostSnapshot } from "./capabilities/types.js";

export type ZenXHostConfig = Omit<ZenHostOptions, "journal" | "threadMetadata">;

export type HostCommand =
  | {
      type: "start";
      config: ZenXHostConfig;
      bearerToken: string;
      capabilities: ZenXCapabilityHostSnapshot;
    }
  | { type: "shutdown" }
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
  const type = (value as { type?: unknown }).type;
  return (
    type === "start" || type === "shutdown" || type === "capability/result"
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
  };
  return (
    (event.type === "ready" && typeof event.url === "string") ||
    (event.type === "error" && typeof event.message === "string") ||
    ((event.type === "capability/invoke" ||
      event.type === "capability/cancel") &&
      typeof event.invocationId === "string")
  );
}

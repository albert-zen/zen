import type { ZenHostOptions } from "../../../../apps/cli/src/host.js";

export type ZenXHostConfig = Omit<ZenHostOptions, "journal" | "threadMetadata">;

export type HostCommand =
  | {
      type: "start";
      config: ZenXHostConfig;
      bearerToken: string;
    }
  | { type: "shutdown" };

export type HostEvent =
  { type: "ready"; url: string } | { type: "error"; message: string };

export function isHostCommand(value: unknown): value is HostCommand {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === "start" || type === "shutdown";
}

export function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const event = value as { type?: unknown; url?: unknown; message?: unknown };
  return (
    (event.type === "ready" && typeof event.url === "string") ||
    (event.type === "error" && typeof event.message === "string")
  );
}

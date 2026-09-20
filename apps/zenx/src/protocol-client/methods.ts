import type { ClientRequestMethod } from "./types.js";

export const clientRequestMethods = [
  "zen/initialize",
  "account/read",
  "skills/list",
  "model/list",
  "thread/start",
  "thread/fork",
  "thread/resume",
  "zen/thread/resume",
  "zen/thread/read",
  "thread/read",
  "thread/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/settings/update",
  "thread/permissions/update",
  "thread/unsubscribe",
  "thread/compact",
  "turn/start",
  "turn/steer",
  "turn/queue",
  "turn/queue/resume",
  "turn/replace",
  "turn/interrupt",
] as const satisfies readonly Exclude<ClientRequestMethod, "initialize">[];

export function isClientRequestMethod(
  value: unknown,
): value is (typeof clientRequestMethods)[number] {
  return (
    typeof value === "string" &&
    (clientRequestMethods as readonly string[]).includes(value)
  );
}

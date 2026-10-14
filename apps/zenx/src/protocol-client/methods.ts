import type { ClientRequestMethod } from "./types.js";

export const clientRequestMethods = [
  "zen/initialize",
  "zen/thread/message",
  "zen/turn/send",
  "zen/turn/wake",
  "zen/turn/send-unarchived",
  "zen/turn/wake",
  "account/read",
  "skills/list",
  "model/list",
  "thread/start",
  "thread/fork",
  "thread/resume",
  "zen/thread/resume",
  "zen/thread/read",
  "zen/thread/import/preview",
  "zen/thread/import",
  "zen/thread/delete",
  "zen/thread/deleted/list",
  "zen/thread/restore",
  "zen/thread/create-child",
  "zen/thread/queue/cancel",
  "zen/thread/queue/edit",
  "thread/read",
  "thread/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/settings/update",
  "thread/permissions/update",
  "thread/unsubscribe",
  "thread/compact",
  "thread/original/read",
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

import type { ClientRequestMethod } from "./types.js";

export const clientRequestMethods = [
  "account/read",
  "skills/list",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/list",
  "thread/name/set",
  "thread/settings/update",
  "thread/unsubscribe",
  "turn/start",
  "turn/steer",
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

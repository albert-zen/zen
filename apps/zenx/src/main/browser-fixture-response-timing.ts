import type { ServerResponse } from "node:http";

/** Passive, bounded fixture diagnostics. Never records URLs, bodies or headers. */
export function observeFixtureResponseTiming(
  response: Pick<ServerResponse, "once">,
  record: (event: { phase: string; atMs: number }) => void,
  now: () => number = Date.now,
): void {
  const emit = (phase: string) => record({ phase, atMs: now() });
  emit("received");
  response.once("finish", () => emit("response-finished"));
  response.once("close", () => emit("response-closed"));
}

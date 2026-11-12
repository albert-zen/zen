import type { Host } from "./session.mjs";
export const fixtureHosts: Host[];
export const fixtureTransport: Parameters<
  typeof import("./session.mjs").createSession
>[0];

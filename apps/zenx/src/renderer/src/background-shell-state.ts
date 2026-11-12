import type { ShellSessionSummary } from "../../../../../src/shell-session.js";
import type { ShellPanelListing } from "../../shell-panel.js";

/** Current Host observations only; never reconstruct process lifetime from Items. */
export function shellListing(
  value: unknown,
  threadId: string,
): ShellPanelListing {
  const listing = value as ShellPanelListing | null;
  if (
    !listing ||
    listing.host !== "local" ||
    !Array.isArray(listing.sessions) ||
    listing.sessions.some(
      (session) =>
        !session ||
        session.threadId !== threadId ||
        typeof session.taskId !== "string" ||
        !session.taskId ||
        typeof session.command !== "string" ||
        !["agent", "user"].includes(session.origin) ||
        !["command", "terminal"].includes(session.kind) ||
        ![
          "queued",
          "running",
          "completed",
          "failed",
          "timed_out",
          "cancel_requested",
          "cancellation_unconfirmed",
          "cancelled",
        ].includes(session.status),
    ) ||
    new Set(listing.sessions.map((session) => session.taskId)).size !==
      listing.sessions.length
  )
    throw new Error("Invalid Shell session observation for this thread");
  return listing;
}

export type BackgroundShellPhase =
  | "running"
  | "starting"
  | "queued"
  | "output"
  | "stopping"
  | "unconfirmed"
  | "ended";
export function backgroundShellPhase(
  session: ShellSessionSummary,
): BackgroundShellPhase {
  if (session.status === "queued") return "queued";
  if (session.status === "cancel_requested") return "stopping";
  if (session.status === "cancellation_unconfirmed") return "unconfirmed";
  if (session.status !== "running") return "ended";
  if (session.lifecycle?.foreground === "exited") return "output";
  // Task admission is not proof of a successful native spawn.
  return session.lifecycle?.foreground === "running" ? "running" : "starting";
}

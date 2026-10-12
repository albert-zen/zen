import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { AgentSessionBinding } from "./agent-providers/types.js";
import type {
  ZenXProjectProjection,
  ZenXProjectProjectionSnapshot,
  ProjectProjectionThread,
} from "./project-projection.js";

/** Display-only navigation identity; never a Zen Thread ID or native session ID. */
export function agentSessionNavigationId(bindingId: string): string {
  return `agent:${bindingId}`;
}

/** All conversation workspaces pass through the same Host canonical projection. */
export function projectConversationLocators(
  threads: readonly NativeThreadSummary[],
  sessions: readonly AgentSessionBinding[],
): ProjectProjectionThread[] {
  return [
    ...threads.map((thread) => ({
      id: thread.threadId,
      cwd: thread.status === "systemError" ? null : thread.currentMetadata.cwd,
    })),
    ...sessions.map((session) => ({
      id: agentSessionNavigationId(session.id),
      cwd: session.cwd,
    })),
  ];
}

/** A source failure stays explicit without blocking the other native history owner. */
export async function readProjectConversationNavigation(
  projection: ZenXProjectProjection,
  readZen: () => Promise<readonly NativeThreadSummary[]>,
  readAgent: () => Promise<readonly AgentSessionBinding[]>,
): Promise<ZenXProjectProjectionSnapshot> {
  const [zen, agent] = await Promise.allSettled([readZen(), readAgent()]);
  const snapshot = await projection.project(
    projectConversationLocators(
      zen.status === "fulfilled" ? zen.value : [],
      agent.status === "fulfilled" ? agent.value : [],
    ),
  );
  if (zen.status === "fulfilled" && agent.status === "fulfilled")
    return snapshot;
  const message = (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason);
  return {
    ...snapshot,
    sourceErrors: {
      ...(zen.status === "rejected" ? { zen: message(zen.reason) } : {}),
      ...(agent.status === "rejected" ? { agent: message(agent.reason) } : {}),
    },
  };
}

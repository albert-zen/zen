import type { CanonicalItem } from "../src/item.js";
export function historyWindowFixture(count: number): CanonicalItem[] {
  return [
    {
      type: "thread_metadata",
      id: "metadata",
      threadId: "thread",
      createdAt: "2026-01-01T00:00:00Z",
      cwd: "/tmp",
      modelId: "fake",
      providerProfileId: "fake",
      reasoningEffort: "medium",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    ...Array.from({ length: count }, (_, index) => [
      {
        type: "turn_started",
        id: `start-${index}`,
        turnId: `turn-${index}`,
        threadId: "thread",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        type: "user_message",
        id: `user-${index}`,
        turnId: `turn-${index}`,
        threadId: "thread",
        createdAt: "2026-01-01T00:00:00Z",
        content: [{ type: "text", text: `User ${index}: `.padEnd(1024, "x") }],
      },
      {
        type: "agent_message",
        id: `agent-${index}`,
        turnId: `turn-${index}`,
        threadId: "thread",
        createdAt: "2026-01-01T00:00:00Z",
        text: `Answer ${index}: `.padEnd(1024, "y"),
      },
      {
        type: "turn_completed",
        id: `end-${index}`,
        turnId: `turn-${index}`,
        threadId: "thread",
        createdAt: "2026-01-01T00:00:00Z",
        status: "completed",
      },
    ]),
  ].flat() as CanonicalItem[];
}

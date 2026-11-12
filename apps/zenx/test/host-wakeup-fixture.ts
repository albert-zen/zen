import assert from "node:assert/strict";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type {
  TriggerSnapshot,
  TriggerHistoryEntry,
} from "../src/main/trigger-types.js";
import type { ThreadItem } from "../src/protocol-client/index.js";
type HostItem = Extract<ThreadItem, { type: "hostMessage" }>;
export async function createRealHostWakeupFixture(
  source: "trigger" | "room",
): Promise<{ item: HostItem; entry: TriggerHistoryEntry }> {
  let saved: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  let wake: any;
  const service = new ZenXTriggerService(
    {
      request: async (method: any, params: any) => {
        if (method === "zen/turn/wake") {
          wake = params;
          return { mode: "steer", turnId: "turn" } as any;
        }
        return {} as any;
      },
      onNotification: () => () => {},
    },
    {
      read: async () => structuredClone(saved),
      write: async (value) => {
        saved = canonicalTriggerSnapshot(value);
      },
    },
  );
  await service.start();
  try {
    const room = await service.createRoom({
      name: "Release room",
      members: [{ name: "Reviewer", threadId: "thread" }],
    });
    await service.create({
      threadId: "thread",
      label: "Release check",
      prompt: "Inspect the release and report only risks.",
      ...(source === "trigger"
        ? { kind: "signal", signalName: "release-ready" }
        : { kind: "roomMention", roomId: room.id, mention: "Reviewer" }),
    });
    if (source === "trigger")
      await service.signal("release-ready", "event-source-uuid-123: new build");
    else
      await service.postAgentRoomMessage(
        room.id,
        "@Reviewer inspect the build",
        undefined,
        "origin-thread-uuid",
      );
    assert.ok(wake);
    assert.match(wake.text, /^\[ZenX trigger wakeup\]/);
    assert.match(wake.text, /Injected prompt:/);
    return {
      item: {
        type: "hostMessage",
        id: `host-${source}`,
        clientId: wake.clientId,
        source: wake.source,
        sourceId: wake.sourceId,
        text: wake.text,
        mode: "steer",
      },
      entry: structuredClone(service.snapshot().history[0]!),
    };
  } finally {
    await service.stop();
  }
}

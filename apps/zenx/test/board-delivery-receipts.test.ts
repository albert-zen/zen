import assert from "node:assert/strict";
import test from "node:test";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { ZenXBoardCapabilityPackage } from "../src/main/capabilities/board-package.js";
import type {
  BoardDocument,
  BoardEventResult,
  BoardOwner,
} from "../../../packages/zenx-board-plugin/src/board.js";

const owner = { kind: "room" as const, roomId: "room-a", threadId: "member-a" };
function receipt(status: string = "running") {
  return {
    kind: "room",
    roomId: owner.roomId,
    threadId: owner.threadId,
    delivery: {
      roomId: owner.roomId,
      operationId: "epoch:synthetic",
      messageId: "message-1",
      state: "saved",
      text: "Assembled",
      createdAt: 1,
      mentions: [
        {
          threadId: owner.threadId,
          name: "Member",
          configuredNow: true,
          deliveries: [
            { status, triggerId: "trigger-1", historyId: "history-1" },
          ],
        },
      ],
    },
  };
}
function invokeInput(args: Record<string, unknown>, ui = false) {
  return {
    name: ui ? "zenx_board_ui" : "zenx_board_put",
    callId: "synthetic",
    cwd: "/synthetic",
    threadId: owner.threadId,
    arguments: ui ? { input: args } : args,
    signal: new AbortController().signal,
    ...(ui ? { trustedPluginUi: true as const } : {}),
  };
}
async function fixture(delivery: unknown) {
  const sdk = createFixturePluginHost({ pluginId: "zenx-board" }).sdk;
  let sends = 0;
  let executions = 0;
  let checks = 0;
  let rejectOwnerAfter: number | undefined;
  const service = new ZenXBoardCapabilityPackage({
    readOwner: async (value: BoardOwner) => {
      checks++;
      if (rejectOwnerAfter !== undefined && checks >= rejectOwnerAfter)
        throw new Error("Exact member removed");
      return value;
    },
    makeClientId: () => "one-explicit-click",
    deliver: async () => {
      sends++;
      return delivery;
    },
    execute: async () => {
      executions++;
      return { exitCode: 0, output: "synthetic" };
    },
  });
  service.start(sdk);
  const document: BoardDocument = {
    id: "synthetic",
    title: "Synthetic",
    summary: "Receipt test",
    owner,
    blocks: [],
    events: [
      {
        id: "submit-then-script",
        label: "Send, then script",
        actions: [
          { kind: "submit", text: "Assembled" },
          { kind: "script", command: "echo synthetic" },
        ],
      },
    ],
  };
  await service.invoke("zenx_board_put", invokeInput({ document }));
  return {
    service,
    sdk,
    document,
    counts: () => ({ sends, executions }),
    rejectNextAction: () => {
      rejectOwnerAfter = checks + 3;
    },
    run: (extra: Record<string, unknown> = {}) =>
      service.invoke(
        "zenx_board_ui",
        invokeInput(
          {
            operation: "event",
            owner,
            revision: 1,
            draftRevision: 0,
            eventId: "submit-then-script",
            ...extra,
          },
          true,
        ),
      ) as Promise<BoardEventResult>,
  };
}

for (const status of ["failed", "unknown", "pending", "queued", "unconfigured"])
  test(`Room ${status} is retained, visible, and cannot advance composed actions`, async () => {
    const delivery = receipt(status);
    const f = await fixture(delivery);
    const result = await f.run();
    assert.match(result.error!, new RegExp(`admission is ${status}`));
    assert.deepEqual(result.outcomes, [{ kind: "submit", result: delivery }]);
    assert.deepEqual(f.counts(), { sends: 1, executions: 0 });
    assert.equal(
      JSON.stringify(await f.sdk.storage.get()).includes("history-1"),
      false,
      "observations never become a Board execution ledger",
    );
  });

for (const status of ["running", "completed"])
  test(`exact ${status} Room admission can continue without claiming model completion`, async () => {
    const delivery = receipt(status);
    const f = await fixture(delivery);
    const result = await f.run();
    assert.equal(result.error, undefined);
    assert.equal(result.outcomes[0]!.result, delivery);
    assert.deepEqual(
      result.outcomes.map((entry) => entry.kind),
      ["submit", "script"],
    );
    assert.deepEqual(f.counts(), { sends: 1, executions: 1 });
  });

for (const [label, mutate] of [
  [
    "wrong outer Room",
    (value: ReturnType<typeof receipt>) => {
      value.roomId = "room-b";
    },
  ],
  [
    "wrong outer member",
    (value: ReturnType<typeof receipt>) => {
      value.threadId = "member-b";
    },
  ],
  [
    "wrong saved Room",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.roomId = "room-b";
    },
  ],
  [
    "wrong recipient",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.mentions[0]!.threadId = "member-b";
    },
  ],
  [
    "multiple recipients",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.mentions.push(
        structuredClone(value.delivery.mentions[0]!),
      );
    },
  ],
  [
    "multiple deliveries",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.mentions[0]!.deliveries.push(
        structuredClone(value.delivery.mentions[0]!.deliveries[0]!),
      );
    },
  ],
  [
    "not saved",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.state = "prepared";
    },
  ],
  [
    "missing message",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.messageId = "";
    },
  ],
  [
    "missing native receipt",
    (value: ReturnType<typeof receipt>) => {
      value.delivery.mentions[0]!.deliveries[0]!.historyId = "";
    },
  ],
] as const)
  test(`${label} is not accepted as exact Room admission`, async () => {
    const delivery = receipt();
    mutate(delivery);
    const f = await fixture(delivery);
    const result = await f.run();
    assert.match(result.error!, /admission is unconfirmed/);
    assert.deepEqual(result.outcomes, [{ kind: "submit", result: delivery }]);
    assert.deepEqual(f.counts(), { sends: 1, executions: 0 });
  });

test("malformed Room outcome is retained without repeated delivery", async () => {
  const f = await fixture(null);
  const result = await f.run();
  assert.match(result.error!, /admission is unconfirmed/);
  assert.deepEqual(result.outcomes, [{ kind: "submit", result: null }]);
  assert.deepEqual(f.counts(), { sends: 1, executions: 0 });
});

test("stale action and substitute execution member fail before effects", async () => {
  const f = await fixture(receipt());
  await assert.rejects(f.run({ revision: 0 }), /Board changed/);
  await assert.rejects(
    f.run({ owner: { ...owner, threadId: "member-b" } }),
    /owner is unavailable/,
  );
  assert.deepEqual(f.counts(), { sends: 0, executions: 0 });
});

test("membership removed after an admitted submit prevents later script", async () => {
  const f = await fixture(receipt());
  f.rejectNextAction();
  const result = await f.run();
  assert.match(result.error!, /Exact member removed/);
  assert.deepEqual(f.counts(), { sends: 1, executions: 0 });
  assert.deepEqual(
    result.outcomes.map((entry) => entry.kind),
    ["submit"],
  );
});

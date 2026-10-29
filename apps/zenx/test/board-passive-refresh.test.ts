import assert from "node:assert/strict";
import test from "node:test";
import { BoardHostService } from "../src/main/board-host-service.js";
import { ZenXBoardCapabilityPackage } from "../src/main/capabilities/board-package.js";
import { createFixturePluginHost } from "@zenx/plugin-sdk";

test("40 passive Board refreshes use 40 summaries and no full Thread reads", async () => {
  let summaries = 0;
  let fullReads = 0;
  const owner = { kind: "thread" as const, threadId: "synthetic-owner" };
  const host = new BoardHostService({
    appServer: {
      request: async () => {
        fullReads++;
        throw new Error("No transcript reads");
      },
    } as any,
    readThreadSummary: async (threadId) => {
      summaries++;
      return { threadId, archived: false };
    },
    rooms: {
      roomsAvailable: () => false,
      snapshot: () => ({ rooms: [] }),
      postAddressedRoomMessage: async () => assert.fail("No delivery"),
    },
    executeTool: async () => assert.fail("No execution"),
  });
  const board = new ZenXBoardCapabilityPackage(host);
  board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
  for (let index = 0; index < 40; index++)
    assert.equal(
      await board.invoke("zenx_board_ui", {
        name: "zenx_board_ui",
        callId: `read-${index}`,
        cwd: "/synthetic",
        threadId: owner.threadId,
        trustedPluginUi: true,
        arguments: { input: { operation: "read", owner } },
        signal: new AbortController().signal,
      }),
      null,
    );
  assert.equal(summaries, 40);
  assert.equal(fullReads, 0);
});

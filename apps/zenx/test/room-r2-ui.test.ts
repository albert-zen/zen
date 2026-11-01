import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import { AutomationTransactionStore } from "../src/main/automation-transaction-store.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test(
  "trusted Room UI displays exact prepared cancel after reload and releases composer without sending",
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "zen-room-cancel-ui-"));
    let holdCancelCommit = false;
    let cancelTarget: { roomId: string; operationId: string } | undefined;
    const commitEntered = deferred();
    const releaseCommit = deferred();
    const append = AutomationTransactionStore.prototype.append;
    t.mock.method(
      AutomationTransactionStore.prototype,
      "append",
      async function (
        this: AutomationTransactionStore,
        transaction: Parameters<typeof append>[0],
      ) {
        if (
          holdCancelCommit &&
          transaction.metadata.rooms.some(
            (room) =>
              room.id === cancelTarget?.roomId &&
              room.operations?.some(
                (operation) =>
                  operation.id === cancelTarget?.operationId &&
                  operation.cancelled === true,
              ),
          )
        ) {
          holdCancelCommit = false;
          commitEntered.resolve();
          await waitForPhase(
            releaseCommit.promise,
            "release cancellation append",
          );
        }
        return append.call(this, transaction);
      },
    );
    const service = await createBundledAutomationPluginService({
      userDataDirectory: dir,
      appServer: {
        request: async () => {
          throw Error("no wake");
        },
        onNotification: () => () => {},
      } as any,
    });
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(window, { zenx: { threads: { list: async () => [] } } });
    const runtime = createZenXTrustedPlugin(service);
    let root: ReturnType<typeof createRoot> | undefined;
    try {
      await service.startPlugin("zenx-rooms", {} as any);
      const room = await service.createRoom({
        name: "Cancel me",
        members: [{ name: "Bot", threadId: "target" }],
      });
      const id = `${room.operationEpoch}:${randomUUID()}`;
      await service.prepareRoomMessage(room.id, id, "draft not to send");
      const commands: Record<string, string> = {
        list: "zenx_rooms_list",
        messages: "zenx_rooms_messages",
        operations: "zenx_rooms_operations",
        operation: "zenx_rooms_operation",
        delivery: "zenx_rooms_delivery",
        "cancel-prepared": "zenx_rooms_cancel_prepared",
        "post-message": "zenx_rooms_post_message",
        "prepare-message": "zenx_rooms_prepare_message",
        "ack-operation": "zenx_rooms_ack_operation",
      };
      let cancelCalls = 0;
      let cancelledInspections = 0;
      const initialHistoryRead = deferred();
      const cancelledHistoryRead = deferred();
      const sdk = {
        commands: {
          execute: async (command: string, input?: unknown) => {
            const tool = commands[command];
            if (!tool) throw Error(`Unknown command: ${command}`);
            const answer = await runtime.invoke(tool, {
              callId: randomUUID(),
              trustedPluginUi: true,
              arguments: { input: input ?? {} },
              cwd: dir,
              signal: new AbortController().signal,
            });
            if (command === "cancel-prepared" && cancelCalls++ === 0)
              throw Error("QA cancel receipt was lost after commit");
            if (
              command === "operation" &&
              (answer as { state?: string }).state === "cancelled"
            ) {
              assert.deepEqual(input, { roomId: room.id, operationId: id });
              cancelledInspections += 1;
            }
            if (command === "messages") {
              if (cancelledInspections > 0) cancelledHistoryRead.resolve();
              else initialHistoryRead.resolve();
            }
            return answer;
          },
        },
        navigation: { navigate: () => {} },
      } as unknown as PluginUiSdkV1;
      root = createRoot(document.getElementById("root")!);
      await act(async () =>
        root!.render(React.createElement(RoomsPage, { sdk })),
      );
      await act(async () =>
        waitForPhase(initialHistoryRead.promise, "initial history read"),
      );
      const composer =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input");
      assert(composer);
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .action-orb",
        )?.disabled,
        true,
      );
      assert.match(
        document.querySelector(".room-send-pending")?.textContent ?? "",
        /Cancel unsent message/u,
      );
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => b.textContent?.trim() === "Cancel unsent message");
      assert(button);
      cancelTarget = { roomId: room.id, operationId: id };
      holdCancelCommit = true;
      await act(async () => button.click());
      await act(async () =>
        waitForPhase(commitEntered.promise, "cancellation append admission"),
      );
      // Clicking is not completion: the Host has not committed cancellation yet.
      assert.equal(service.roomOperation(room.id, id).state, "prepared");
      assert(document.querySelector(".room-send-pending"));
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .action-orb",
        )?.disabled,
        true,
        "pending cancellation must not allow another send",
      );
      assert.equal(service.snapshot().rooms[0]?.messages.length, 0);
      // Wait for the lost-receipt inspection and its refresh, not elapsed time.
      await act(async () => {
        releaseCommit.resolve();
        await waitForPhase(
          cancelledHistoryRead.promise,
          "lost receipt inspection refresh",
        );
      });
      assert.equal(
        cancelledInspections,
        1,
        "lost reply is checked by exact operation ID",
      );
      assert.equal(service.roomOperation(room.id, id).state, "cancelled");
      assert.equal(service.snapshot().rooms[0]?.messages.length, 0);
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .action-orb",
        )?.disabled,
        true,
        "empty draft alone disables Send",
      );
      assert.equal(
        document.querySelector(".room-send-pending"),
        null,
        "confirmed cancellation clears exact pending only",
      );
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")
          ?.disabled,
        false,
      );
      assert.equal(
        cancelCalls,
        1,
        "lost reply must be inspected rather than retried",
      );
    } finally {
      releaseCommit.resolve();
      if (root) await act(async () => root!.unmount());
      dom.window.close();
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForPhase(
  promise: Promise<void>,
  phase: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error(`Timed out waiting for ${phase}`)),
          1500,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

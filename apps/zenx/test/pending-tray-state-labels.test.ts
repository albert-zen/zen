import assert from "node:assert/strict";
import test from "node:test";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import { queueScenario } from "./fixtures/agent-queue-data.js";
import { QueueMutationUnknownError } from "../src/renderer/src/queue-mutation-state.js";
import type { NativeQueueSteerResult } from "../../../src/protocol/native/wire.js";

const steerButton = () =>
  document.querySelector<HTMLButtonElement>(".queue-row-steer")!;
const status = () =>
  steerButton().querySelector('[role="status"]')?.textContent;

test("a promotion row distinguishes pending write from confirmed receipt while keeping actions locked", async () => {
  await withRuntimeDom(async (h) => {
    let finish!: (value: NativeQueueSteerResult) => void;
    let calls = 0;
    await h.render(queueScenario(0), {
      onSteerQueued: async () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await h.click(".queue-row-steer");
    assert.equal(status(), "Sending…");
    await act(async () =>
      finish({
        queuedItemId: "queue-0",
        clientId: "queue-client-0",
        status: "staged",
        turnId: "runtime-turn",
        revision: 1,
        promotionItemId: "promotion",
      }),
    );
    assert.equal(status(), "Accepted");
    assert.match(steerButton().getAttribute("aria-label")!, /Accepted/);
    assert.equal(steerButton().disabled, true);
    await act(async () => steerButton().click());
    assert.equal(calls, 1);
  });
});

test("unknown promotion and its read-only check never claim another send or unlock the row", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(0);
    let sends = 0;
    let reads = 0;
    let conflictingWrites = 0;
    let finishRead!: (value: unknown) => void;
    Object.defineProperty(window, "zenx", {
      configurable: true,
      value: {
        protocol: {
          request: async (method: string) => {
            assert.equal(method, "zen/thread/read");
            reads++;
            return new Promise((resolve) => {
              finishRead = resolve;
            });
          },
        },
      },
    });
    await h.render(thread, {
      onSteerQueued: async () => {
        sends++;
        throw new QueueMutationUnknownError("Outcome unknown");
      },
      onCancelQueued: async () => {
        conflictingWrites++;
        return { results: [] };
      },
      onReorderQueued: async () => {
        conflictingWrites++;
        return { status: "reordered", reorderItemId: "unused" };
      },
      onEditQueued: async (target) => {
        conflictingWrites++;
        return {
          status: "edited",
          queuedItemId: target.queuedItemId,
          clientId: target.clientId,
          revision: target.expectedRevision + 1,
          editItemId: "unused",
        };
      },
    });
    await h.click(".queue-row-steer");
    assert.equal(status(), "Unconfirmed");
    assert.equal(steerButton().disabled, true);
    const check = document.querySelector<HTMLButtonElement>(
      ".queue-mutation-status button",
    )!;
    await act(async () => {
      check.click();
      check.click();
    });
    assert.equal(status(), "Checking…");
    assert.match(
      document.querySelector(".queue-mutation-status")!.textContent!,
      /Checking pending messages/,
    );
    assert.equal(document.querySelector(".queue-mutation-status button"), null);
    await act(async () => check.click());
    assert.equal(reads, 1);
    assert.equal(sends, 1);
    assert.ok(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".queue-row-actions button",
        ),
      ].every((button) => button.disabled),
    );
    await act(async () => {
      for (const button of document.querySelectorAll<HTMLButtonElement>(
        ".queue-row-actions button",
      ))
        button.click();
    });
    assert.equal(conflictingWrites, 0);
    await act(async () =>
      finishRead({ thread: { id: thread.id, items: thread.canonicalItems } }),
    );
    assert.equal(status(), "Unconfirmed");
    assert.equal(steerButton().disabled, true);
    assert.equal(reads, 1);
    assert.equal(sends, 1);
  });
});

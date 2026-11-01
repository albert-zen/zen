import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom, act } from "./agent-runtime-dom.js";
import {
  runtimeThread,
  runtimeMessage,
  runtimeApproval,
} from "./fixtures/agent-runtime-data.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";
import { i18n } from "../src/renderer/src/i18n.js";

test("streaming skips historical Turn bodies while changed props and contexts remain live", async () => {
  await withRuntimeDom(async (h) => {
    const reads = Array<number>(100).fill(0);
    let thread = runtimeThread([]);
    const template = thread.turns[0]!;
    // completedTurnLabel reads durationMs inside the production Turn body.
    // No render-time observer, clock measurement or exported test-only component.
    const counted = (index: number, turn: typeof template) =>
      new Proxy(turn, {
        get(target, key, receiver) {
          if (key === "durationMs") reads[index]!++;
          return Reflect.get(target, key, receiver);
        },
      });
    thread = {
      ...thread,
      turns: reads.map((_, index) =>
        counted(index, {
          ...template,
          id: `turn-${index}`,
          status: index === 99 ? "inProgress" : "completed",
          durationMs: index === 99 ? null : 1000,
          completedAt: index === 99 ? null : template.startedAt! + 1,
          items: [
            runtimeMessage(
              `message-${index}`,
              `History ${index} [file](/tmp/example.txt)`,
            ),
          ],
        }),
      ),
    };
    const oldLinks: string[] = [],
      newLinks: string[] = [];
    let onOpenMessageLink = (target: { value: string }) => {
      oldLinks.push(target.value);
    };
    await h.render(thread, { wakeups: [], onOpenMessageLink });
    assert.ok(reads.slice(0, 99).every((count) => count > 0));
    const first = document.querySelector(".turn");
    for (let i = 0; i < 3; i++) {
      thread = applyNativeThreadEvent(thread, {
        type: "item_delta",
        threadId: thread.id,
        turnId: "turn-99",
        itemId: "message-99",
        delta: " delta",
      });
      reads.fill(0);
      await h.render(thread, { wakeups: [], onOpenMessageLink });
      assert.deepEqual(reads.slice(0, 99), Array(99).fill(0));
      assert.equal(document.querySelector(".turn"), first);
      assert.ok(
        document
          .querySelectorAll(".agent-copy")[99]!
          .textContent!.endsWith(" delta".repeat(i + 1)),
      );
    }
    await act(async () =>
      document.querySelector<HTMLAnchorElement>(".agent-copy a")!.click(),
    );
    assert.deepEqual(oldLinks, ["/tmp/example.txt"]);
    onOpenMessageLink = (target) => {
      newLinks.push(target.value);
    };
    reads.fill(0);
    await h.render(thread, { wakeups: [], onOpenMessageLink });
    await act(async () =>
      document.querySelector<HTMLAnchorElement>(".agent-copy a")!.click(),
    );
    assert.deepEqual(newLinks, ["/tmp/example.txt"]);
    assert.deepEqual(reads.slice(0, 99), Array(99).fill(0));

    thread = {
      ...thread,
      turns: thread.turns.map((turn, index) =>
        index === 0 ? counted(index, { ...turn, durationMs: 7000 }) : turn,
      ),
    };
    reads.fill(0);
    await h.render(thread, { onOpenMessageLink });
    assert.ok(reads[0]! > 0);
    assert.deepEqual(reads.slice(1, 99), Array(98).fill(0));
    assert.match(first!.textContent!, /7s/);
    const approval = {
      ...runtimeApproval,
      params: {
        ...runtimeApproval.params,
        threadId: thread.id,
        turnId: "turn-0",
      },
    };
    reads.fill(0);
    await h.render(thread, { approvals: [approval], onOpenMessageLink });
    assert.ok(reads[0]! > 0);
    assert.deepEqual(reads.slice(1, 99), Array(98).fill(0));
    reads.fill(0);
    await h.render(thread, {
      approvals: [
        { ...approval, params: { ...approval.params, turnId: "turn-1" } },
      ],
      onOpenMessageLink,
    });
    assert.ok(reads[0]! > 0 && reads[1]! > 0);
    assert.deepEqual(reads.slice(2, 99), Array(97).fill(0));
    const language = i18n.language;
    try {
      reads.fill(0);
      await act(async () => {
        await i18n.changeLanguage("zh");
      });
      assert.ok(reads.slice(0, 99).every((count) => count > 0));
    } finally {
      await act(async () => {
        await i18n.changeLanguage(language);
      });
    }
  });
});

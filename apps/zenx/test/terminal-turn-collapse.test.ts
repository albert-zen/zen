import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeCommand,
  runtimeIntro,
  runtimeMessage,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";

for (const status of ["interrupted", "failed"] as const) {
  test(`${status} without a final reply hides all intermediate messages by default and restores them only on expansion`, async () => {
    await withRuntimeDom(async (h) => {
      const items = [
        ...runtimeIntro,
        runtimeCommand("tool-a"),
        runtimeMessage("progress-b", "Intermediate B, not a final answer."),
        runtimeCommand("tool-c", "sleep 10", "unknown"),
        runtimeMessage("partial-d", "Incomplete D, not a final answer."),
      ];
      const thread = runtimeThread(items, status);
      const original = JSON.stringify(thread);
      await h.render(thread);
      const assertCollapsed = () => {
        assert.equal(
          document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
          "false",
        );
        assert.equal(document.querySelector(".turn-history"), null);
        assert.equal(document.querySelector(".turn-final"), null);
        assert.equal(document.querySelectorAll(".agent-message").length, 0);
        assert.doesNotMatch(
          document.body.textContent!,
          /Intermediate B|Incomplete D/u,
        );
        assert.ok(document.querySelector(".user-row"));
        assert.ok(document.querySelector(".turn-outcome"));
      };
      assertCollapsed();
      await h.click(".turn-toggle");
      assert.match(
        document.querySelector(".turn-history")!.textContent!,
        /Intermediate B/u,
      );
      assert.match(
        document.querySelector(".turn-history")!.textContent!,
        /Incomplete D/u,
      );
      assert.equal(document.querySelector(".turn-final"), null);
      await h.render({ ...thread });
      assert.equal(
        document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
        "true",
      );
      await h.click(".turn-toggle");
      await h.hide();
      await h.render(thread);
      assertCollapsed();
      assert.equal(
        JSON.stringify(thread),
        original,
        "Disclosure never rewrites canonical/projected history",
      );
    });
  });

  test(`live → ${status} collapses intermediate messages without inventing a final reply`, async () => {
    await withRuntimeDom(async (h) => {
      const items = [
        ...runtimeIntro,
        runtimeCommand("tool"),
        runtimeMessage("partial", "Visible while running"),
      ];
      await h.render(runtimeThread(items));
      assert.match(
        document.querySelector(".turn-history")!.textContent!,
        /Visible while running/u,
      );
      await h.render(runtimeThread(items, status));
      assert.equal(document.querySelector(".turn-history"), null);
      assert.equal(document.querySelector(".turn-final"), null);
      assert.ok(document.querySelector(".turn-outcome"));
    });
  });
}

test("completed collapse keeps the actual final response exactly once", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread(
      [
        ...runtimeIntro,
        runtimeCommand("tool"),
        runtimeMessage("final", "Actual completed answer"),
      ],
      "completed",
    );
    await h.render(thread);
    assert.equal(document.querySelector(".turn-history"), null);
    assert.equal(document.querySelectorAll(".turn-final").length, 1);
    assert.match(
      document.querySelector(".turn-final")!.textContent!,
      /Actual completed answer/u,
    );
    await h.click(".turn-toggle");
    assert.doesNotMatch(
      document.querySelector(".turn-history")!.textContent!,
      /Actual completed answer/u,
    );
    assert.equal(document.querySelectorAll(".turn-final").length, 1);
  });
});

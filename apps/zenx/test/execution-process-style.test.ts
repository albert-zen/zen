import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ThreadItem } from "../src/protocol-client/index.js";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeCommand,
  runtimeIntro,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
  runtimeWait,
} from "./fixtures/agent-runtime-data.js";
const thinking: ThreadItem = {
  type: "reasoning",
  id: "thinking",
  status: "inProgress",
  summary: ["Inspecting current implementation"],
  content: [],
};
for (const theme of ["light", "dark"]) {
  test(`${theme}: explicit total stays above history across active phases`, async () => {
    await withRuntimeDom(async (h) => {
      document.documentElement.dataset.appearance = theme;
      for (const [phase, item] of [
        ["running", runtimeTask("running", "task-one", "running")],
        ["thinking", thinking],
        ["waiting", runtimeWait("waiting", "task-one")],
        ["requested", runtimeCommand("requested", "echo ready", "inProgress")],
      ] as const) {
        await h.render(runtimeThread([item]));
        const turn = document.querySelector(".turn")!;
        const metadata = turn.querySelector(":scope > .turn-running-label")!;
        const history = turn.querySelector(":scope > .turn-history")!;
        assert.ok(metadata, `${phase}: direct top metadata`);
        assert.equal(metadata.getAttribute("data-phase"), phase);
        assert.ok(
          metadata.compareDocumentPosition(history) &
            window.Node.DOCUMENT_POSITION_FOLLOWING,
        );
        assert.equal(turn.querySelectorAll(".turn-duration").length, 1);
        assert.match(
          metadata.querySelector(".turn-duration")!.textContent!,
          /Total elapsed/u,
        );
        assert.equal(history.querySelector(".turn-duration"), null);
        assert.equal(turn.querySelector(".turn-status-footer"), null);
      }
    });
  });
}
test("completing the same turn leaves metadata above history and preserves focus", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread([
        ...runtimeIntro,
        runtimeTask("operation", "task-one", "running"),
      ]),
    );
    const turn = document.querySelector(".turn")!;
    const metadata = turn.querySelector(":scope > .turn-running-label")!;
    const index = [...turn.children].indexOf(metadata);
    assert.equal(index, 1);
    assert.equal(metadata.nextElementSibling?.className, "turn-history");
    const tool = turn.querySelector<HTMLButtonElement>(
      ".trace-item-toggle, .trace-item-static",
    )!;
    await act(async () => tool.focus());
    await h.render(
      runtimeThread(
        [
          ...runtimeIntro,
          runtimeTask("operation", "task-one", "completed"),
          runtimeMessage("answer", "Checks finished."),
        ],
        "completed",
      ),
    );
    assert.equal(document.querySelector(".turn"), turn);
    const header = turn.querySelector(":scope > .turn-toggle")!;
    assert.equal([...turn.children].indexOf(header), index);
    assert.equal(header.nextElementSibling?.className, "turn-history");
    assert.match(header.textContent!, /Worked.*3s/u);
    assert.equal(
      turn.querySelector(
        ".turn-running-label, .turn-status-footer, .turn-duration",
      ),
      null,
    );
    assert.equal(document.activeElement, tool);
  });
});
test("active group and singleton icons sweep with text while waits and completion stay static", async () => {
  await withRuntimeDom(async (h) => {
    for (const grouped of [false, true]) {
      const base = grouped ? [runtimeCommand("previous")] : [];
      await h.render(runtimeThread([...base, thinking]));
      const row = document.querySelector(
        grouped ? ".trace-toggle" : ".trace-item-toggle, .trace-item-static",
      )!;
      assert.ok(row.querySelector(".activity-sweep svg"));
      assert.equal(
        row.querySelector(".activity-text")?.getAttribute("data-active"),
        "true",
      );
      await h.render(runtimeThread([...base, runtimeWait("wait", "task-one")]));
      const waiting = document.querySelector(
        grouped ? ".trace-toggle" : ".trace-item-toggle, .trace-item-static",
      )!;
      assert.equal(waiting.querySelector(".activity-sweep svg"), null);
      assert.equal(
        waiting.querySelector(".activity-text")?.getAttribute("data-active"),
        "false",
      );
    }
  });
});
test("icon sweep is stroke-only, visibility-gated and reduced-motion safe", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/activity-text.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /mask-image: var\(--activity-shimmer-mask\)/u);
  assert.match(css, /activity-sweep 2\.2s steps\(30\) infinite paused/u);
  assert.match(css, /data-animating="true"/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\), \(forced-colors: active\)\s*\{\s*\.activity-sweep\s*\{\s*display: none;/su,
  );
});

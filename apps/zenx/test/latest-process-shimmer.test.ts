import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeApproval,
  runtimeCommand,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import type { ThreadItem } from "../src/protocol-client/index.js";
import { i18n } from "../src/renderer/src/i18n.js";

function sequences() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      ".turn-history > .trace-singleton, .turn-history > .trace-group",
    ),
  ];
}
function activeHeaders() {
  return sequences().map(
    (sequence) =>
      sequence.querySelector(".activity-text")?.getAttribute("data-active") ===
      "true",
  );
}
const a = runtimeTask("a-running", "background-a", "running");
const b = runtimeMessage(
  "b-commentary",
  "B is an intermediate assistant message.",
);

for (const grouped of [false, true]) {
  for (const state of [
    "requested",
    "yielded",
    "settled",
    "thinking",
  ] as const) {
    test(`${grouped ? "group" : "singleton"} C (${state}) sweeps only for an actual pending invocation or thinking after returned A and assistant B`, async () => {
      await withRuntimeDom(async (h) => {
        const c: ThreadItem =
          state === "thinking"
            ? {
                type: "reasoning",
                id: "c-thinking",
                summary: [],
                content: ["Public synthetic reasoning"],
                status: "inProgress",
              }
            : state === "yielded"
              ? runtimeTask("c-current", "task-c", "running")
              : runtimeCommand(
                  "c-current",
                  "echo latest",
                  state === "requested" ? "inProgress" : "completed",
                );
        const items = [
          a,
          b,
          ...(grouped ? [runtimeCommand("c-prior")] : []),
          c,
        ];
        const original = JSON.stringify(items);
        const expectedActive = state === "requested" || state === "thinking";
        await h.render(runtimeThread([a]));
        assert.deepEqual(activeHeaders(), [false]);
        const old = sequences()[0];
        await h.render(runtimeThread(items));
        assert.ok(
          sequences()[0] === old,
          "Earlier returned invocation keeps stable identity",
        );
        assert.deepEqual(activeHeaders(), [false, expectedActive]);
        assert.equal(
          document.querySelectorAll(".turn-history .activity-sweep").length,
          expectedActive ? 1 : 0,
        );
        assert.equal(
          old?.getAttribute("data-unsettled"),
          "false",
          "Earlier returned invocation stays settled independently of its process",
        );
        const header = sequences()[1]!.querySelector(
          ".trace-activity-title, .trace-item-label",
        )!;
        assert.equal(
          header.getAttribute("title")?.split(" · ")[0] ===
            "Agent is still working",
          expectedActive,
        );
        assert.equal(
          header.parentElement?.querySelector(":scope > .sr-only")
            ?.textContent === "Agent is still working",
          expectedActive,
        );
        const toggle = sequences()[1]!.querySelector("button")!;
        await h.click(
          grouped
            ? ".trace-group > button"
            : ".trace-singleton:last-child > button",
        );
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(
          document.querySelectorAll(".turn-history .activity-sweep").length,
          expectedActive ? 1 : 0,
          "Expanded details never add or revive a completed invocation sweep",
        );
        await h.render(
          runtimeThread([
            ...items,
            runtimeMessage(
              "d-commentary",
              "Still working without a new process item",
            ),
          ]),
        );
        assert.deepEqual(activeHeaders(), [false, expectedActive]);
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(JSON.stringify(items), original);
      });
    });
  }
}

test("approval and stopping retain distinct states without an execution sweep", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread([
      a,
      b,
      runtimeCommand("approval-call", "run_code", "inProgress"),
    ]);
    await h.render(thread, { approvals: [runtimeApproval] });
    assert.deepEqual(activeHeaders(), [false, false]);
    assert.match(
      document.querySelector(".trace-singleton:last-child")!.textContent!,
      /Approval required/u,
    );
    await h.render(thread, {
      composer: emptyComposerState(),
      onInterrupt: async () => {},
    });
    await h.click('[aria-label="Stop"]');
    assert.deepEqual(activeHeaders(), [false, false]);
  });
});

for (const status of ["completed", "interrupted", "failed"] as const) {
  test(`${status} never sweeps even if an old background result remains nonterminal`, async () => {
    await withRuntimeDom(async (h) => {
      const thread = runtimeThread([a, b, runtimeCommand("c")], status);
      await h.render(thread);
      await h.click(".turn-toggle");
      assert.ok(activeHeaders().every((active) => !active));
      assert.ok(
        document.querySelector(".turn-history .activity-sweep") === null,
        "Terminal process history has no activity sweep",
      );
    });
  });
}

test("ongoing activity copy is concise in both interface languages", () => {
  assert.equal(
    i18n.t("shell:ongoingTurnActivity", { lng: "en" }),
    "Agent is still working",
  );
  assert.equal(
    i18n.t("shell:ongoingTurnActivity", { lng: "zh-CN" }),
    "Agent 仍在工作",
  );
});

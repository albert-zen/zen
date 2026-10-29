import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ThreadItem } from "../src/protocol-client/index.js";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeApproval,
  runtimeCommand,
  runtimeIntro,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
  runtimeWait,
} from "./fixtures/agent-runtime-data.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { recoveryScenario } from "./fixtures/loop-recovery-scenario.js";
import { i18n } from "../src/renderer/src/i18n.js";
const thinking: ThreadItem = {
  type: "reasoning",
  id: "thinking",
  status: "inProgress",
  summary: ["Inspecting current implementation"],
  content: [],
};
for (const theme of ["light", "dark"]) {
  test(`${theme}: T3 work-duration header stays icon-free above history across active phases`, async () => {
    await withRuntimeDom(async (h) => {
      document.documentElement.dataset.appearance = theme;
      for (const [phase, item] of [
        ["running", runtimeTask("running", "task-one", "running")],
        ["thinking", thinking],
        [
          "waiting",
          { ...runtimeWait("waiting", "task-one"), status: "inProgress" },
        ],
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
          /^Working for /u,
        );
        assert.ok(
          metadata.querySelector("svg") === null,
          "No phase-dependent leading glyph",
        );
        assert.equal(
          metadata.querySelector('[role="status"]')?.className,
          "sr-only",
        );
        assert.ok(
          history.querySelector(".turn-duration") === null,
          "History does not duplicate the work duration",
        );
        assert.ok(
          turn.querySelector(".turn-status-footer") === null,
          "Active work metadata stays above history",
        );
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
    assert.ok(
      document.querySelector(".turn") === turn,
      "Completing a turn preserves its mounted element",
    );
    const header = turn.querySelector(":scope > .turn-toggle")!;
    assert.equal([...turn.children].indexOf(header), index);
    assert.equal(header.nextElementSibling?.className, "turn-history");
    assert.match(header.textContent!, /Worked.*3s/u);
    assert.ok(
      turn.querySelector(
        ".turn-running-label, .turn-status-footer, .turn-duration",
      ) === null,
      "Completed turn has no duplicate active metadata",
    );
    assert.ok(
      document.activeElement === tool,
      "Completing a turn preserves tool focus",
    );
  });
});
test("latest group and singleton icons sweep through returned waits until the turn completes", async () => {
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
      const items = [...base, runtimeWait("wait", "task-one")];
      await h.render(runtimeThread(items));
      const waiting = document.querySelector(
        grouped ? ".trace-toggle" : ".trace-item-toggle, .trace-item-static",
      )!;
      // The wait invocation is settled, but this latest process still carries
      // the active Turn's model-only continuation cue (ui-ux.md).
      assert.ok(waiting.querySelector(".activity-sweep svg"));
      assert.equal(
        waiting.querySelector(".activity-text")?.getAttribute("data-active"),
        "true",
      );
      assert.equal(
        waiting
          .querySelector(".trace-item-label, .trace-activity-title")!
          .getAttribute("title")
          ?.startsWith("Agent is still working"),
        true,
      );
      await h.render(runtimeThread(items, "completed"));
      if (
        document
          .querySelector(".turn-toggle")
          ?.getAttribute("aria-expanded") === "false"
      ) {
        await h.click(".turn-toggle");
      }
      assert.equal(
        document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
        "true",
      );
      const completed = document.querySelector(
        grouped ? ".trace-toggle" : ".trace-item-toggle, .trace-item-static",
      )!;
      assert.ok(completed, "Completed process remains available in history");
      assert.ok(
        completed.querySelector(".activity-sweep svg") === null,
        "Completed Turns have no active icon sweep",
      );
      assert.equal(
        completed.querySelector(".activity-text")?.getAttribute("data-active"),
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
  assert.match(
    css,
    /activity-sweep 1\.5s steps\(48, end\) 0\.3s infinite paused/u,
  );
  assert.match(css, /data-animating="true"/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\), \(forced-colors: active\)\s*\{\s*\.activity-sweep\s*\{\s*display: none;/su,
  );
});

test("active base icon, prefix and label use muted contrast below the foreground sweep", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/activity-text.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.activity-text\[data-active="true"\] > \.activity-content,\s*\.activity-text\[data-active="true"\] > \.activity-content > strong\s*\{\s*color: var\(--text-3\);/u,
  );
  assert.match(css, /\.activity-sweep\s*\{[^}]*color: var\(--text\);/su);
});

test("shared shimmer mask is valid when inherited from the root theme", async () => {
  const theme = await readFile(
    new URL("../src/renderer/src/theme.css", import.meta.url),
    "utf8",
  );
  const mask = theme.match(/--activity-shimmer-mask: ([\s\S]*?);/u)?.[1];
  assert.ok(mask);
  // Root custom properties resolve before inheritance. A child-only variable here
  // would make the entire inherited mask invalid and leave a solid overlay.
  assert.doesNotMatch(mask, /var\(--activity-band\)/u);
  assert.match(mask, /105deg,[\s\S]*black 40% 60%,[\s\S]*transparent 100%/u);
});

test("approval and stopping retain the same visible work-duration header", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread([
      runtimeCommand("approval-call", "echo ready", "inProgress"),
    ]);
    await h.render(thread, { approvals: [runtimeApproval] });
    let header = document.querySelector(".turn-running-label")!;
    assert.equal(header.getAttribute("data-phase"), "approval");
    assert.match(
      header.querySelector(".turn-work-label")!.textContent!,
      /^Working for /u,
    );
    assert.ok(
      header.querySelector("svg") === null,
      "Approval metadata has no leading glyph",
    );
    assert.ok(
      document.querySelector(".approval-request-allow"),
      "Approval action stays separate",
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.render(thread, {
      composer: emptyComposerState(),
      onInterrupt: () => pending,
    });
    await h.click(".action-orb");
    header = document.querySelector(".turn-running-label")!;
    assert.equal(header.getAttribute("data-phase"), "stopping");
    assert.match(
      header.querySelector(".turn-work-label")!.textContent!,
      /^Working for /u,
    );
    assert.ok(
      header.querySelector("svg") === null,
      "Stopping metadata has no leading glyph",
    );
    await act(async () => release());
  });
});
test("Chinese active and completed headers both use 已工作 at the same text anchor", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    await withRuntimeDom(async (h) => {
      await h.render(runtimeThread([thinking]));
      assert.match(
        document.querySelector(".turn-running-label .turn-work-label")!
          .textContent!,
        /^已工作 /u,
      );
      await h.render(
        runtimeThread([{ ...thinking, status: undefined }], "completed"),
      );
      const header = document.querySelector(".turn-toggle")!;
      assert.equal(header.firstElementChild?.className, "turn-work-label");
      assert.match(header.firstElementChild!.textContent!, /^已工作 /u);
      assert.equal(
        header.lastElementChild?.tagName.toLowerCase(),
        "svg",
        "Only trailing fold glyph remains",
      );
    });
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("unknown start/end and recovery never invent a work duration", async () => {
  for (const language of ["en", "zh-CN"]) {
    await i18n.changeLanguage(language);
    try {
      await withRuntimeDom(async (h) => {
        const active = runtimeThread([thinking]);
        active.turns[0]!.startedAt = null;
        await h.render(active);
        assert.ok(
          document.querySelector(".turn-duration") === null,
          "Missing start time does not invent an active duration",
        );
        assert.equal(
          document.querySelector(".turn-work-label")!.textContent,
          i18n.t("shell:working"),
        );
        await h.render(recoveryScenario("recovering"));
        assert.ok(
          document.querySelector(".turn-duration") === null,
          "Recovery does not invent a work duration",
        );
        assert.equal(
          document.querySelector(".turn-work-label")!.textContent,
          i18n.t("shell:working"),
        );
        assert.match(
          document.querySelector('[role="status"].sr-only')!.textContent!,
          language === "en" ? /Retrying/u : /正在重试/u,
        );
        const recovery = document.querySelector(".turn-recovery-attempt")!;
        assert.ok(
          recovery.closest(".sr-only") === null,
          "Recovery attempt remains visible",
        );
        assert.ok(
          recovery.closest(".turn-work-label") === null,
          "Recovery attempt remains separate from the work label",
        );
        assert.match(
          recovery.textContent!,
          language === "en" ? /Retrying.*Attempt 1/u : /正在重试.*第 1 次/u,
        );
        const done = runtimeThread(
          [runtimeMessage("answer", "done")],
          "completed",
        );
        done.turns[0]!.startedAt = null;
        done.turns[0]!.completedAt = null;
        done.turns[0]!.durationMs = null;
        await h.render(done);
        assert.equal(
          document.querySelector(".turn-work-label")!.textContent,
          i18n.t("shell:worked"),
        );
      });
    } finally {
      await i18n.changeLanguage("en");
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "../src/protocol-client/index.js";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeCommand,
  runtimeTask,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";

const thinking = (content: string): ThreadItem => ({
  type: "reasoning",
  id: "streaming-thought",
  status: "inProgress",
  summary: ["Provider summary"],
  content: content ? [content] : [],
});
const title = () => document.querySelector(".turn-history .activity-content")!;
for (const grouped of [false, true]) {
  test(`${grouped ? "group" : "singleton"}: actual public reasoning streams beside Thinking without resetting disclosure`, async () => {
    await withRuntimeDom(async (h) => {
      const prior = grouped ? [runtimeCommand("prior")] : [];
      await h.render(
        runtimeThread([...prior, thinking("Read the renderer source")]),
      );
      assert.equal(title().querySelector("strong")?.textContent, "Thinking");
      assert.equal(
        title().querySelector(".activity-label")?.textContent,
        "Read the renderer source",
      );
      const row = document.querySelector<HTMLButtonElement>(
        grouped ? ".trace-toggle" : ".trace-item-toggle",
      )!;
      const before = title();
      await h.click(grouped ? ".trace-toggle" : ".trace-item-toggle");
      await h.render(
        runtimeThread([
          ...prior,
          thinking(
            "Read the renderer source and check the latest streaming update.",
          ),
        ]),
      );
      assert.ok(title() === before, "Streaming preserves the title element");
      assert.equal(row.getAttribute("aria-expanded"), "true");
      assert.match(title().textContent!, /latest streaming update/u);
      assert.doesNotMatch(title().textContent!, /Provider summary/u);
      const long =
        "Earlier paragraph.\n\n" + "Streaming 内容 ".repeat(100) + "LATEST";
      await h.render(runtimeThread([...prior, thinking(long)]));
      const excerpt = title().querySelector(".activity-label")!.textContent!;
      assert.ok([...excerpt].length <= 240);
      assert.ok(excerpt.endsWith("LATEST"));
      assert.doesNotMatch(excerpt, /\n/u);
    });
  });
  test(`${grouped ? "group" : "singleton"}: pending call previews the complete actual command, not its friendly title`, async () => {
    await withRuntimeDom(async (h) => {
      const prior = grouped ? [runtimeCommand("prior")] : [];
      for (const command of [
        "pwd",
        "cd /synthetic/workspace && node scripts/verify.mjs --component ActivityText --include-streaming-reasoning --include-long-commands --theme light --theme dark --width 420 --width 1280",
      ]) {
        const task = {
          ...runtimeCommand("operation", command, "inProgress"),
          toolName: "run_code",
          toolArguments: { code: command, description: "Friendly short title" },
        };
        await h.render(runtimeThread([...prior, task]));
        assert.equal(
          title().querySelector(".activity-label")?.textContent,
          command,
        );
        assert.doesNotMatch(title().textContent!, /Friendly short title/u);
        assert.equal(
          title().closest(".activity-text")?.getAttribute("data-preview"),
          "true",
        );
        assert.equal(
          Boolean(title().parentElement!.querySelector(".activity-sweep svg")),
          true,
        );
      }
    });
  });
  test(`${grouped ? "group" : "singleton"}: returned calls stop previewing and animating even while their task runs`, async () => {
    await withRuntimeDom(async (h) => {
      const prior = grouped ? [runtimeCommand("prior")] : [];
      const task = runtimeTask("operation", "task-one", "running");
      await h.render(runtimeThread([...prior, task]));
      assert.equal(
        title().closest(".activity-text")?.getAttribute("data-preview"),
        null,
      );
      assert.equal(Boolean(document.querySelector(".activity-sweep")), false);
      if (grouped) await h.click(".trace-toggle");
      assert.equal(Boolean(document.querySelector(".mini-spinner")), false);
      assert.deepEqual(
        Array.from(document.querySelectorAll(".trace-item-status")).map(
          (status) => status.textContent,
        ),
        grouped ? ["Completed", "Completed"] : ["Completed"],
      );
    });
  });
}
test("reasoning without public text uses only the honest localized fallback", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread([{ ...thinking(""), summary: [] } as ThreadItem]),
    );
    assert.equal(title().textContent, "Thinking");
    assert.equal(title().querySelector(".activity-label")?.textContent, "");
    assert.ok(title().parentElement!.querySelector(".activity-sweep svg"));
  });
});

test("content-only reasoning advances while its empty summary stays unchanged", async () => {
  await withRuntimeDom(async (h) => {
    for (const content of [
      "Public reasoning",
      "Public reasoning delta arrives",
    ]) {
      await h.render(
        runtimeThread([{ ...thinking(content), summary: [] } as ThreadItem]),
      );
      assert.equal(
        title().querySelector(".activity-label")?.textContent,
        content,
      );
    }
  });
});

test("group preview follows live reasoning rather than already-returned task receipts", async () => {
  await withRuntimeDom(async (h) => {
    const first = {
      ...runtimeTask("first", "task-one", "running"),
      command: "first actual command",
    };
    const latest = {
      ...runtimeTask("second", "task-two", "running"),
      command: "selected actual command",
    };
    await h.render(
      runtimeThread([first, latest, thinking("A later reasoning item")]),
    );
    assert.equal(
      title().querySelector(".activity-label")?.textContent,
      "A later reasoning item",
    );
    assert.equal(title().querySelector("strong")?.textContent, "Thinking");
    assert.equal(
      title().closest(".activity-text")?.getAttribute("data-preview"),
      "true",
    );
    assert.equal(Boolean(document.querySelector(".activity-sweep svg")), true);
    await h.click(".trace-toggle");
    assert.equal(document.querySelectorAll(".tool-status.completed").length, 2);
    assert.equal(document.querySelectorAll(".mini-spinner").length, 1);
    assert.equal(
      document.querySelector(".mini-spinner")?.getAttribute("aria-label"),
      "Thinking",
    );
  });
});

test("truncated reasoning marks omitted context without broken Latin words or Unicode characters", async () => {
  await withRuntimeDom(async (h) => {
    const content =
      "Earlier context ".repeat(30) + "clippedword " + "x".repeat(230);
    await h.render(runtimeThread([thinking(content)]));
    assert.equal(
      title().querySelector(".activity-label")?.textContent,
      "… " + "x".repeat(230),
    );
    await h.click(".trace-item-toggle");
    assert.equal(document.querySelector(".trace-detail")?.textContent, content);
    const unicode = "公开正文🧭".repeat(100) + "末尾";
    await h.render(runtimeThread([thinking(unicode)]));
    const excerpt = title().querySelector(".activity-label")!.textContent!;
    assert.equal([...excerpt].length, 240);
    assert.ok(excerpt.startsWith("… "));
    assert.ok(excerpt.endsWith("末尾"));
    assert.equal(excerpt.includes("�"), false);
    assert.equal(document.querySelector(".trace-detail")?.textContent, unicode);
  });
});

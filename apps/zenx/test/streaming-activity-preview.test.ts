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
      assert.equal(title(), before);
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
  test(`${grouped ? "group" : "singleton"}: command preview is the complete actual command, not its friendly title`, async () => {
    await withRuntimeDom(async (h) => {
      const prior = grouped ? [runtimeCommand("prior")] : [];
      for (const command of [
        "pwd",
        "cd /synthetic/workspace && node scripts/verify.mjs --component ActivityText --include-streaming-reasoning --include-long-commands --theme light --theme dark --width 420 --width 1280",
      ]) {
        const task = {
          ...runtimeTask("operation", "task-one", "running"),
          command,
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
      }
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

test("group preview uses the existing observed current task, not a later reasoning item", async () => {
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
      "selected actual command",
    );
  });
});

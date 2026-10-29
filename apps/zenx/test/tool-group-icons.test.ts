import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { traceGroupIcons } from "../src/renderer/src/turn-projection.js";
import { toolPresentation } from "../src/renderer/src/tool-presentation.js";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeCommand,
  runtimeTask,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";

const call = (id: string, toolName: string) => ({
  ...runtimeCommand(id, toolName),
  toolName,
});

test("group glyphs use a bounded first-seen set of existing tool presentations", () => {
  const reasoning = {
    type: "reasoning" as const,
    id: "thinking",
    summary: ["Considering the next step"],
    content: [],
  };
  assert.deepEqual(traceGroupIcons([reasoning]), ["reasoning"]);
  assert.deepEqual(
    traceGroupIcons([
      reasoning,
      call("page", "browser_inspect"),
      call("type", "browser_type"),
    ]),
    ["browser"],
    "different actions with one capability glyph must not imply a mixed icon",
  );
  assert.deepEqual(
    traceGroupIcons([
      call("workspace", "zenx_browser_workspace_type"),
      call("connected", "zenx_browser_connected_inspect"),
      call("shell", "zenx_shell"),
    ]),
    ["browser", "terminal"],
  );
  assert.deepEqual(
    traceGroupIcons([
      call("image", "view_image"),
      call("page", "browser_inspect"),
      call("shell", "shell"),
      call("image-again", "view_image"),
    ]),
    ["image", "browser"],
    "later types cannot displace or grow the first two glyphs",
  );
  assert.deepEqual(
    traceGroupIcons([call("parent", "run_code"), call("child", "shell")]),
    ["terminal"],
  );
  const unknown = "acme_read_synthetic_record";
  assert.deepEqual(traceGroupIcons([call("unknown", unknown)]), [
    toolPresentation(unknown).icon,
  ]);
});

test("adding tool types preserves the mounted decorative slot, activity and disclosure", async () => {
  await withRuntimeDom(async (h) => {
    const first = runtimeCommand("first", "npm test", "inProgress");
    const second = runtimeCommand("second");
    await h.render(runtimeThread([first, second]));
    const toggle = document.querySelector<HTMLButtonElement>(".trace-toggle")!;
    const slot = toggle.querySelector(".trace-tool-icons")!;
    const title = toggle.querySelector(".trace-activity-title")!;
    const label = title.textContent;
    const glyphs = () =>
      [...slot.querySelectorAll("svg")].map((svg) =>
        svg.getAttribute("data-icon"),
      );
    assert.deepEqual(glyphs(), ["terminal"]);
    assert.equal(slot.getAttribute("aria-hidden"), "true");
    assert.ok(
      slot.querySelector("[tabindex], [role], button, a") === null,
      "Decorative glyphs do not add focusable or semantic controls",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    const page = call("page", "browser_inspect");
    await h.render(runtimeThread([first, second, page]));
    assert.ok(
      toggle.querySelector(".trace-tool-icons") === slot,
      "Adding a capability preserves the mounted icon slot",
    );
    assert.ok(
      toggle.querySelector(".trace-activity-title") === title,
      "Adding a capability preserves the mounted activity title",
    );
    assert.equal(title.textContent, label);
    assert.equal(
      title.getAttribute("title"),
      `Agent is still working · ${label}`,
    );
    assert.deepEqual(glyphs(), ["terminal", "browser"]);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      title.querySelector(".activity-text")?.getAttribute("data-active"),
      "true",
    );

    await h.click(".trace-toggle");
    await h.render(
      runtimeThread([first, second, page, call("image", "view_image")]),
    );
    assert.ok(
      document.querySelector(".trace-toggle") === toggle,
      "Adding another capability preserves the expanded disclosure",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.deepEqual(glyphs(), ["terminal", "browser"]);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value,
      "Keep this unsent draft.",
    );
  });
});

test("wide and narrow group rows fit the visible glyphs without a phantom second slot", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.trace-toggle\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 14px;/su,
  );
  assert.match(
    css,
    /@container \(max-width: 460px\)\s*\{\s*\.trace-toggle\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 14px;/su,
  );
  const slot = css.match(/\.trace-tool-icons\s*\{([^}]+)\}/su)?.[1] ?? "";
  for (const declaration of [
    "display: flex;",
    "width: max-content;",
    "min-width: 16px;",
    "max-width: 32px;",
    "height: 16px;",
    "justify-content: flex-start;",
    "gap: 2px;",
    "flex-shrink: 0;",
    "overflow: hidden;",
  ]) {
    assert.ok(slot.includes(declaration), declaration);
  }
  assert.match(css, /\.trace-tool-icons > svg\s*\{\s*flex: none;/su);
});

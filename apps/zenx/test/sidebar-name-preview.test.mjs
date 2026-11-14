import assert from "node:assert/strict";
import test from "node:test";
import { verifySidebarName } from "../scripts/reading-main-ui-preview.mjs";
test("full-name evidence rejects truncated, clipped, invisible or non-keyboard states", () => {
  const state = {
    text: "A complete long title",
    visible: true,
    clipped: false,
    focusVisible: true,
  };
  verifySidebarName(state, state.text, { keyboard: true });
  for (const change of [
    { text: "A complete…" },
    { visible: false },
    { clipped: true },
    { focusVisible: false },
  ]) {
    assert.throws(() =>
      verifySidebarName({ ...state, ...change }, state.text, {
        keyboard: true,
      }),
    );
  }
  verifySidebarName({ ...state, focusVisible: false }, state.text);
});

test("child context names only unique, already-loaded named parents without shortening similar titles", async () => {
  const { tsImport } = await import("tsx/esm/api");
  const { uniqueSidebarParentTitles } = await tsImport(
    "../src/renderer/src/sidebar-child-context.ts",
    import.meta.url,
  );
  const row = (threadId, name) => ({
    threadId,
    name,
    preview: "Not an invented parent name",
  });
  const input = [
    row("parent-a", "Shared project · implementation"),
    row("parent-b", "Shared project · investigation"),
    row(
      "long",
      "A long actual parent title ending in its distinguishing details",
    ),
    row("zh", "中文父会话完整名称"),
    row("empty", "  "),
    row("missing", undefined),
  ];
  const snapshot = structuredClone(input);
  const titles = uniqueSidebarParentTitles(input);
  assert.equal(titles.get("parent-a"), "Shared project · implementation");
  assert.equal(titles.get("parent-b"), "Shared project · investigation");
  assert.equal(titles.get("long"), input[2].name);
  assert.equal(titles.get("zh"), input[3].name);
  assert.equal(titles.has("unknown"), false);
  assert.equal(titles.has("empty"), false);
  assert.equal(titles.has("missing"), false);
  assert.deepEqual(input, snapshot);
  for (const name of [
    "[ZenX trigger wakeup] Source Thread: raw-private-id",
    "  [ZenX trigger wakeup] Source Room: raw-room-id",
    "[ZenX trigger wakeup]",
  ]) {
    assert.equal(
      uniqueSidebarParentTitles([row("wakeup", name)]).size,
      0,
      "Never turn a wakeup envelope or routing ID into parent context",
    );
  }
  const unavailable = {
    ...row("unavailable", "Failed noncanonical name"),
    status: "systemError",
  };
  assert.equal(uniqueSidebarParentTitles([unavailable]).size, 0);
  assert.equal(
    uniqueSidebarParentTitles([row("a", "Same name"), row("b", "Same name")])
      .size,
    0,
  );
  assert.equal(
    uniqueSidebarParentTitles([
      row("a", "First name"),
      row("a", "Changed name"),
    ]).size,
    0,
  );
  assert.equal(
    uniqueSidebarParentTitles([row("a", " Same name "), row("b", "Same name")])
      .size,
    0,
  );
});

test("child context stays noninteractive metadata, preserves compact/status rules and uses mounted IDs", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [source, css, shell] = await Promise.all([
    read("../src/renderer/src/Sidebar.tsx"),
    read("../src/renderer/src/styles.css"),
    read("../src/renderer/src/i18n/shell.ts"),
  ]);
  assert.equal((source.match(/\n\s+showChildContext\n/g) ?? []).length, 2);
  assert.match(source, /rowScope="recent"\s+showChildContext/);
  assert.match(
    source,
    /projectWorkspace=\{group.workspace\}\s+showChildContext/,
  );
  assert.match(source, /showChildContext = false/);
  assert.match(source, /showChildContext &&\s*thread.status !== "systemError"/);
  const errorRow = source.slice(
    source.indexOf("className={`thread-row system-error"),
    source.indexOf("className={`thread-row${selected"),
  );
  assert.doesNotMatch(errorRow, /aria-describedby/);
  assert.match(source, /const childDescriptionId = useId\(\)/);
  assert.match(
    source,
    /className="thread-child-label"\s+aria-hidden="true"\s+title=\{childDescription\}/,
  );
  assert.match(
    source,
    /aria-describedby=\{childDescription \? childDescriptionId : undefined\}/,
  );
  assert.match(
    source,
    /<span id=\{childDescriptionId\} className="sr-only">\s*\{childDescription\}/,
  );
  assert.match(
    source,
    /className="thread-model-name" title=\{identity.label\}>\s*\{identity.label\}/,
  );
  assert.match(source, /onSelectThread\(thread.threadId\)/);
  assert.match(
    css,
    /\.sidebar\[data-thread-density="compact"\] \.thread-model\s*\{\s*display: none;/,
  );
  assert.match(
    css,
    /\.thread-child-label\s*\{\s*flex: 0 0 auto;\s*white-space: nowrap;/,
  );
  assert.match(
    css,
    /\.thread-state-inline\s*\{\s*display: inline-flex;\s*flex: 0 0 auto;/,
  );
  assert.match(shell, /sidebarChild: "Child"/);
  assert.match(shell, /sidebarChild: "子会话"/);
  assert.match(shell, /sidebarChildOf: "Child of \{\{parent\}\}"/);
});

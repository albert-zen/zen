import assert from "node:assert/strict";
import test from "node:test";
import {
  createResultFileFixture,
  RESULT_FILE_MARKDOWN,
  RESULT_FILE_TEXT,
} from "./fixtures/ui-polish-result-file.ts";
test("explicit existing artifact is bounded and inert until read", async () => {
  const f = createResultFileFixture();
  assert.deepEqual(f.receipt().reads, []);
  assert.match(
    RESULT_FILE_MARKDOWN,
    /\[Open the synthetic review result\]\(RESULT\.md\)/,
  );
  const value = await f.read("thread-1", "RESULT.md");
  assert.equal(value.path, "RESULT.md");
  assert.equal(value.text, RESULT_FILE_TEXT);
  assert.deepEqual(Object.keys(value).sort(), ["path", "revision", "text"]);
  value.text = "changed local copy";
  assert.equal((await f.read("thread-1", "RESULT.md")).text, RESULT_FILE_TEXT);
  assert.deepEqual(Object.keys(f).sort(), ["read", "receipt"]);
  const receipt = f.receipt();
  receipt.reads.length = 0;
  assert.equal(f.receipt().reads.length, 2);
});
test("wrong owner, missing file and traversal never masquerade as successful read", async () => {
  const f = createResultFileFixture();
  for (const [owner, path] of [
    ["thread-2", "RESULT.md"],
    ["thread-1", "missing.md"],
    ["thread-1", "../RESULT.md"],
    ["thread-1", "/etc/passwd"],
  ])
    await assert.rejects(f.read(owner, path), /rejected/);
  assert.deepEqual(f.receipt().reads, []);
});
import { resultFileSceneEnabled } from "./fixtures/ui-polish-result-file.ts";
test("opt-in is exclusive and ordinary reading remains untouched", () => {
  assert.equal(
    resultFileSceneEnabled(new URLSearchParams("scene=reading")),
    false,
  );
  assert.equal(
    resultFileSceneEnabled(new URLSearchParams("scene=reading&resultFile=1")),
    true,
  );
  assert.throws(() =>
    resultFileSceneEnabled(
      new URLSearchParams("scene=navigation&resultFile=1"),
    ),
  );
  for (const key of [
    "results",
    "inlineTrace",
    "nestedOutput",
    "codeWrap",
    "tableKeyboard",
    "childQuestions",
    "streaming",
    "pending",
    "busyChild",
    "conversationTabs",
    "launchers",
  ])
    assert.throws(() =>
      resultFileSceneEnabled(
        new URLSearchParams("scene=reading&resultFile=1&" + key + "=1"),
      ),
    );
});

import {
  verifyResultFile,
  RESULT_DRAFT,
} from "../scripts/result-file-main-ui-preview.mjs";
const base = {
  receipt: {
    synthetic: true,
    owner: "thread-1",
    path: "RESULT.md",
    reads: [],
    activeReads: 0,
    maxConcurrentReads: 0,
  },
  draft: RESULT_DRAFT,
  href: "http://fixture/#/threads/thread-1",
  alerts: [],
  link: { href: "RESULT.md", focused: true, focusVisible: true },
  marker: { text: "same marker", rect: { y: 100, bottom: 140 } },
  messages: { rect: { y: 50, bottom: 800 } },
  composer: { y: 774, width: 700 },
  closeVisible: false,
  workspaceOpen: false,
};
const opened = {
  ...structuredClone(base),
  receipt: {
    ...base.receipt,
    reads: [
      { threadId: "thread-1", path: "RESULT.md" },
      { threadId: "thread-1", path: "RESULT.md" },
    ],
    maxConcurrentReads: 1,
  },
  selectedFile: { title: "RESULT.md" },
  file: {
    text: "This in-memory document is the exact linked artifact.",
    editable: true,
  },
  closeVisible: true,
  workspaceOpen: true,
};
const returned = {
  ...structuredClone(opened),
  file: null,
  closeVisible: false,
  workspaceOpen: false,
  focus: { id: "thread-browser-toggle" },
};
test("all three evidence phases accept valid synthetic receipts", () => {
  verifyResultFile(base, "focused");
  verifyResultFile(opened, "opened", base);
  verifyResultFile(returned, "returned", base);
});
for (const [name, phase, original, mutate] of [
  [
    "eager file read",
    "focused",
    base,
    (s) => s.receipt.reads.push({ threadId: "thread-1", path: "RESULT.md" }),
  ],
  ["DOM-only focus", "focused", base, (s) => (s.link.focusVisible = false)],
  [
    "wrong file",
    "opened",
    opened,
    (s) => (s.receipt.reads[0].path = "PLAN.md"),
  ],
  [
    "wrong owner",
    "opened",
    opened,
    (s) => (s.receipt.reads[0].threadId = "other"),
  ],
  [
    "replayed read",
    "returned",
    returned,
    (s) => s.receipt.reads.push(s.receipt.reads[0]),
  ],
  [
    "wrong selection",
    "opened",
    opened,
    (s) => (s.selectedFile.title = "PLAN.md"),
  ],
  [
    "invented read-only viewer",
    "opened",
    opened,
    (s) => (s.file.editable = false),
  ],
  [
    "missing second admitted read",
    "opened",
    opened,
    (s) => s.receipt.reads.pop(),
  ],
  [
    "overlapping reads",
    "opened",
    opened,
    (s) => (s.receipt.maxConcurrentReads = 2),
  ],
  ["unsettled read", "opened", opened, (s) => (s.receipt.activeReads = 1)],
  ["lost restored focus", "returned", returned, (s) => (s.focus.id = "")],
  ["lost draft", "returned", returned, (s) => (s.draft = "")],
  ["lost route", "opened", opened, (s) => (s.href = "other")],
  ["reading drift", "returned", returned, (s) => (s.marker.rect.y += 10)],
  ["Composer occlusion", "opened", opened, (s) => (s.marker.rect.bottom = 790)],
  [
    "restored width mismatch",
    "returned",
    returned,
    (s) => (s.composer.width = 400),
  ],
  ["unexpected alert", "opened", opened, (s) => (s.alerts = ["failed"])],
])
  test("reject " + name, () => {
    const s = structuredClone(original);
    mutate(s);
    assert.throws(() => verifyResultFile(s, phase, base));
  });

import { verifyResultFileSource } from "../scripts/result-file-main-ui-preview.mjs";
test("exact source receipt accepts only exact clean reading source", () => {
  const head = "a".repeat(40),
    tree = "b".repeat(40);
  const source = {
    commit: head,
    tree,
    schemaVersion: 1,
    dirtyFiles: [],
    scenes: { reading: {} },
    sources: Object.fromEntries(
      [
        "apps/zenx/scripts/result-file-main-ui-preview.mjs",
        "apps/zenx/test/fixtures/ui-polish-result-file.ts",
        "apps/zenx/test/fixtures/ui-polish-visual.tsx",
        "apps/zenx/scripts/reading-main-ui-preview.mjs",
      ].map((file) => [file, "c".repeat(64)]),
    ),
  };
  verifyResultFileSource(source, head, tree, true);
  for (const mutate of [
    (s) => (s.commit = "d".repeat(40)),
    (s) => (s.tree = "d".repeat(40)),
    (s) => delete s.dirtyFiles,
    (s) => (s.dirtyFiles = [" M apps/zenx/test/fixtures/ui-polish-visual.tsx"]),
    (s) => (s.dirtyFiles = ""),
    (s) => (s.dirtyFiles = {}),
    (s) => (s.dirtyFiles = null),
    (s) => (s.schemaVersion = 0),
    (s) => (s.scenes.extra = {}),
    (s) => delete s.sources["apps/zenx/test/fixtures/ui-polish-result-file.ts"],
  ]) {
    const s = structuredClone(source);
    mutate(s);
    assert.throws(() => verifyResultFileSource(s, head, tree, true));
  }
  assert.throws(() => verifyResultFileSource(source, undefined, tree, true));
  assert.throws(() => verifyResultFileSource(source, head, tree, false));
});

import { observeResultFile } from "../scripts/result-file-main-ui-preview.mjs";
test("retained closed or inert workspace children are not active file controls", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    `
    <aside id="other-panel" data-open="true"><button class="auxiliary-close-button">Unrelated close</button></aside>
    <aside id="thread-workspace-panel" class="auxiliary-panel" data-open="false" inert>
      <button class="auxiliary-close-button" id="actual-close">Close</button>
      <span data-tab-id="file:RESULT.md"><button role="tab" aria-selected="true"
        data-canonical-title="RESULT.md" aria-controls="file-body">RESULT.md</button></span>
      <div id="file-body" role="tabpanel">This in-memory document is the exact linked artifact.</div>
    </aside>`,
    { runScripts: "outside-only" },
  );
  try {
    const { document, HTMLElement } = dom.window;
    // Structural regression only: retained descendants can have nonzero own
    // boxes even when their closed ancestor clips them. Not pixel evidence.
    HTMLElement.prototype.getClientRects = () => [{ width: 24, height: 24 }];
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 24,
      height: 24,
      bottom: 24,
    });
    const panel = document.getElementById("thread-workspace-panel");
    const observe = () =>
      dom.window.eval(`(${observeResultFile.toString()})()`);
    for (const [open, inert] of [
      [false, true],
      [false, false],
      [true, true],
    ]) {
      panel.dataset.open = String(open);
      panel.toggleAttribute("inert", inert);
      const s = observe();
      assert.equal(s.closeVisible, false);
      assert.equal(s.workspaceOpen, false);
      assert.equal(s.closeFocused, false);
      assert.equal(s.selectedFile, undefined);
      assert.equal(s.file, null);
    }
    panel.dataset.open = "true";
    panel.removeAttribute("inert");
    const s = observe();
    assert.equal(s.workspaceOpen, true);
    assert.equal(s.closeVisible, true);
    assert.equal(s.selectedFile.title, "RESULT.md");
    assert.equal(s.selectedFile.tabId, "file:RESULT.md");
    panel.remove();
    assert.equal(
      observe().closeVisible,
      false,
      "Other panel cannot own this control",
    );
  } finally {
    dom.window.close();
  }
});

import { guardReadingBridge } from "./fixtures/ui-polish-reading.ts";
test("existing guard prohibits saves before inner fixture without claiming attempt telemetry", async () => {
  const f = createResultFileFixture();
  let innerSaveCalls = 0;
  const guarded = guardReadingBridge({
    workspaceFiles: {
      read: f.read,
      save() {
        innerSaveCalls++;
        throw new Error("inner save must never run");
      },
    },
  });
  assert.throws(
    () => guarded.workspaceFiles.save(),
    /Reading bridge denied: workspaceFiles.save/,
  );
  assert.equal(innerSaveCalls, 0);
  assert.deepEqual(await guarded.workspaceFiles.read("thread-1", "RESULT.md"), {
    path: "RESULT.md",
    text: RESULT_FILE_TEXT,
    revision: "synthetic-result-0",
  });
});
test("read overlap is observed rather than hidden by fixture deduplication", async () => {
  const f = createResultFileFixture();
  await Promise.all([
    f.read("thread-1", "RESULT.md"),
    f.read("thread-1", "RESULT.md"),
  ]);
  assert.equal(f.receipt().maxConcurrentReads, 2);
  assert.equal(f.receipt().activeReads, 0);
  assert.equal(f.receipt().reads.length, 2);
});

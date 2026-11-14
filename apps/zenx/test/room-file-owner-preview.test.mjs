import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertRoomLabels,
  captureRoomFileOwners,
  assertRoomReceipt,
  roomReceiptPaths,
  roomOwnerReady,
  roomPreviewNeeded,
} from "../scripts/room-file-owner-main-ui-preview.mjs";

const specimen = () => ({
  owner: { kind: "room" },
  labels: ["A", "B"].map((name, i) => ({
    id: `file:@thread-${i ? "b" : "a"}:README.md`,
    label: `README.md 成员 ${name}`,
    title: `README.md 成员 ${name}`,
    closeLabel: `Close README.md 成员 ${name}`,
    tab: { left: 0, right: 112, top: 0, bottom: 30, height: 30 },
    close: { left: 88 },
    closeHit: true,
    filename: {
      rect: { left: 20, right: 70, top: 2, bottom: 14, width: 50, height: 12 },
    },
    owner: {
      text: `成员 ${name}`,
      clientWidth: 50,
      scrollWidth: 40,
      rect: { left: 20, right: 70, top: 14, bottom: 26, width: 50, height: 12 },
    },
  })),
});
test("exact current scoped head is required, never a generic checkout or stale capture", () => {
  const sha = "a".repeat(40),
    p = ["apps/zenx/src/renderer/src/auxiliary-panel.tsx"];
  assert.equal(roomPreviewNeeded(p, sha, sha, sha), true);
  for (const args of [
    [p, sha, sha, "b".repeat(40)],
    [p, sha, "b".repeat(40), sha],
    [p, "main", "main", "main"],
    [["docs/a.md"], sha, sha, sha],
    [[], sha, sha, sha],
  ])
    assert.equal(roomPreviewNeeded(...args), false);
});
test("visible exact-owner labels fit both rows and clear Close", () =>
  assert.doesNotThrow(() =>
    assertRoomLabels(specimen(), ["成员 A", "成员 B"]),
  ));
for (const [name, mutate] of [
  ["different owner", (r) => (r.labels[0].id = "file:@wrong:README.md")],
  ["same visual labels", (r) => (r.labels[1].owner.text = "成员 A")],
  ["truncated owner", (r) => (r.labels[0].owner.scrollWidth = 51)],
  ["hidden owner", (r) => (r.labels[0].owner.clientWidth = 0)],
  ["basename clipped vertically", (r) => (r.labels[0].filename.rect.top = -1)],
  ["basename overlays Close", (r) => (r.labels[0].filename.rect.right = 90)],
  ["owner overlays Close", (r) => (r.labels[0].owner.rect.right = 90)],
  ["larger rail", (r) => (r.labels[0].tab.height = 40)],
  ["occluded Close", (r) => (r.labels[0].closeHit = false)],
])
  test(`rejects ${name}`, () => {
    const r = specimen();
    mutate(r);
    assert.throws(() => assertRoomLabels(r, ["成员 A", "成员 B"]));
  });
test("new route is distinct, read-only scoped, pinned-font verified and leaves legacy gate unchanged", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const main = read("../scripts/capture-main-ui-preview.mjs");
  const workflow = read(
    "../../../.github/workflows/room-file-owner-preview.yml",
  );
  assert.ok(
    main.includes('const desktopRoom = captureProfile === "desktop-room"'),
  );
  assert.ok(main.includes("process.env.GITHUB_ACTIONS"));
  assert.ok(main.includes('assert.equal(process.platform, "linux"'));
  assert.ok(main.includes("browserSandboxDisabled: false"));
  assert.ok(!main.includes('"--no-sandbox"'));
  assert.ok(main.includes("evidence.diagnostics[filename]"));
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.ok(!workflow.includes("workflow_dispatch"));
  assert.ok(!workflow.includes("apt-get"));
  assert.ok(workflow.includes("refs/pull/755/head"));
  assert.ok(workflow.includes("persist-credentials: false"));
  assert.ok(
    workflow.includes(
      "zenx-noto-cjk-523d033d6cb47f4a80c58a35753646f5c3608a78-v1",
    ),
  );
  assert.ok(workflow.includes("prepare-preview-fonts.mjs"));
});

const receipt = () => ({
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  clean: true,
  scenes: { room: { html: "room.html", sha256: "c".repeat(64) } },
  sources: Object.fromEntries(
    roomReceiptPaths.map((file) => [file, "d".repeat(64)]),
  ),
});
test("receipt requires exact single Room scene, clean version, seed sources and hashes", () => {
  assert.doesNotThrow(() => assertRoomReceipt(receipt(), "a".repeat(40)));
  for (const mutate of [
    (r) => (r.commit = "b".repeat(40)),
    (r) => (r.tree = "HEAD"),
    (r) => (r.clean = false),
    (r) => (r.scenes = {}),
    (r) => (r.scenes.other = r.scenes.room),
    (r) => (r.scenes.room.html = "../room.html"),
    (r) => (r.scenes.room.html = "sidebar-state.html"),
    (r) => (r.scenes.room.sha256 = "c"),
    (r) => (r.sources = {}),
    (r) => delete r.sources["apps/zenx/scripts/sidebar-state-preview.tsx"],
    (r) => (r.sources[roomReceiptPaths[0]] = "bad"),
    (r) => (r.sources["apps/zenx/../../private"] = "d".repeat(64)),
  ]) {
    const value = receipt();
    mutate(value);
    assert.throws(() => assertRoomReceipt(value, "a".repeat(40)));
  }
});
test("each required seed source is independently mandatory", () => {
  for (const file of roomReceiptPaths) {
    const value = receipt();
    delete value.sources[file];
    assert.throws(
      () => assertRoomReceipt(value, "a".repeat(40)),
      /Missing Room source/,
    );
  }
});
test("first image requires selected Room B plus exact document and source read", () => {
  const r = {
    owner: { kind: "room", id: "room-shared" },
    states: [
      {
        owner: { kind: "room", id: "room-shared" },
        selectedTab: "file:@thread-b:README.md",
      },
    ],
    selectedDocument: "协作成员 B",
    calls: [{ method: "read", threadId: "thread-b", path: "README.md" }],
  };
  assert.equal(roomOwnerReady(r, "b"), true);
  assert.equal(roomOwnerReady(r, "a"), false);
  for (const mutate of [
    (v) => (v.owner.id = "different"),
    (v) => (v.states[0].selectedTab = "file:@thread-a:README.md"),
    (v) => (v.selectedDocument = "Loading"),
    (v) => (v.calls[0].path = "other.md"),
    (v) => (v.calls[0].threadId = "thread-a"),
  ]) {
    const value = structuredClone(r);
    mutate(value);
    assert.equal(roomOwnerReady(value, "b"), false);
  }
});
test("Room receipt is guarded before any bundle load and old profiles do not import it", () => {
  const main = readFileSync(
    new URL("../scripts/capture-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    main,
    /const roomCapture = desktopRoom\s*\? await import\(".\/room-file-owner-main-ui-preview.mjs"\)\s*: null/,
  );
  assert.ok(
    main.indexOf(
      "A Room bundle requires the desktop-room profile before loading",
    ) < main.indexOf("for (const scene of Object.values(source.scenes))"),
  );
  assert.ok(
    main.indexOf("roomCapture.assertRoomReceipt") <
      main.indexOf(
        "for (const [file, expected] of Object.entries(source.sources))",
      ),
  );
  const module = readFileSync(
    new URL("../scripts/room-file-owner-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  assert.match(module, /sample\?\.labels\?\.length === 2/);
  assert.equal((module.match(/await waitOwner\("b"\)/g) ?? []).length, 2);
});

test("post-load failure preserves a separate diagnostic and rethrows, never acceptance", async () => {
  const evidence = { rendererErrors: [], screenshots: {} },
    diagnostics = [];
  const fail = new Error("Exact B document did not settle");
  let waits = 0,
    captures = 0;
  await assert.rejects(
    captureRoomFileOwners({
      evidence,
      options: { theme: "dark" },
      url: "http://synthetic.invalid/room.html",
      wait: async () => {
        if (++waits === 2) throw fail;
      },
      evaluate: async () => {},
      click: async () => {},
      capture: async () => {
        captures++;
      },
      diagnostic: async (name) => diagnostics.push(name),
    }),
    (error) => error === fail,
  );
  assert.equal(evidence.roomFailure.status, "failed");
  assert.equal(evidence.roomFailure.diagnosticNotAcceptance, true);
  assert.deepEqual(diagnostics, ["diagnostic-room-dark-failed"]);
  assert.equal(captures, 0);
  assert.deepEqual(evidence.roomCases, []);
  assert.deepEqual(evidence.screenshots, {});
});

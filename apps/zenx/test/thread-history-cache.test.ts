import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  replayThreadProjection,
  trimThreadProjectionCache,
} from "../src/renderer/src/App.js";
import {
  emptyComposerState,
  editComposer,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
import { SideChatDrafts } from "../src/renderer/src/side-chat-drafts.js";
import { runtimeThread } from "./fixtures/agent-runtime-data.js";

function entry(id: string, active = false) {
  return replayThreadProjection(
    runtimeThread([], active ? "inProgress" : "completed", id),
    {
      threadId: id,
      model: "fake",
      modelProvider: "fake",
      reasoningEffort: null,
      permissionMode: "read-only",
      approvalPolicy: "never",
    },
    [],
    { processEpoch: "epoch", watermark: 1 },
  );
}

test("32 visited inactive histories retain the same four entries as eight visits", () => {
  const cache = new Map<string, ReturnType<typeof entry>>();
  const composers: Record<string, ComposerState> = {
    "0": {
      ...emptyComposerState(),
      draft: { text: "unsent quote and draft", images: [] },
    },
  };
  for (let i = 0; i < 32; i++) {
    cache.set(String(i), entry(String(i)));
    trimThreadProjectionCache(cache, String(i), composers);
    assert.ok(cache.size <= 5);
  }
  trimThreadProjectionCache(cache, null, composers);
  assert.deepEqual([...cache.keys()], ["28", "29", "30", "31"]);
  assert.equal(composers["0"]!.draft.text, "unsent quote and draft");
});

test("selection, active events, queues and unresolved admissions stay owned", () => {
  const cache = new Map<string, ReturnType<typeof entry>>();
  cache.set("selected", entry("selected"));
  cache.set("active", entry("active", true));
  const queued = entry("queued");
  queued.thread.queuedMessages = [
    {
      id: "queued-input",
      clientId: "pending",
      text: "next",
      imageCount: 0,
    },
  ];
  cache.set("queued", queued);
  cache.set("unconfirmed", entry("unconfirmed"));
  const composers: Record<string, ComposerState> = {
    unconfirmed: {
      ...emptyComposerState(),
      pendingSends: [
        {
          clientId: "unknown",
          intent: "start",
          draft: { text: "keep", images: [] },
          status: "unconfirmed",
          error: null,
        },
      ],
    },
  };
  for (let i = 0; i < 8; i++) cache.set(String(i), entry(String(i)));
  trimThreadProjectionCache(cache, "selected", composers);
  assert.equal(cache.size, 8);
  for (const id of ["selected", "active", "queued", "unconfirmed"])
    assert.ok(cache.has(id), id);
  cache.set("active", entry("active"));
  queued.thread.queuedMessages = [];
  composers.unconfirmed = emptyComposerState();
  trimThreadProjectionCache(cache, null, composers);
  assert.equal(cache.size, 4);
});

test("history eviction preserves a promoted side chat's late image owner", async () => {
  const discarded: ComposerState[] = [];
  let sequence = 0;
  const drafts = new SideChatDrafts(
    () => {},
    () => `draft-${++sequence}`,
    () => "unknown",
    (state) => discarded.push(state),
  );
  const draft = drafts.open("parent", {});
  drafts.updateComposer(draft.id, (state) => editComposer(state, "first"));
  let finishImport!: () => void;
  const importGate = new Promise<void>((resolve) => {
    finishImport = resolve;
  });
  const image = {
    id: "late-image-lease",
    name: "synthetic.png",
    attachment: {
      type: "attachment" as const,
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      width: 1,
      height: 1,
      byteLength: 68,
    },
  };
  const imported = drafts.importImages(draft.id, async () => {
    await importGate;
    return [image];
  });
  await drafts.submit(
    draft.id,
    async () => "child",
    async () => {},
  );
  const composers: Record<string, ComposerState> = {};
  assert.equal(
    drafts.transfer(draft.id, (change) => {
      composers.child = change(composers.child ?? emptyComposerState());
    }),
    true,
  );
  drafts.updateComposer(draft.id, (state) =>
    editComposer(state, "edited while sidebar writes await"),
  );
  const cache = new Map<string, ReturnType<typeof entry>>([
    ["child", entry("child")],
  ]);
  for (let i = 0; i < 32; i++) cache.set(String(i), entry(String(i)));
  trimThreadProjectionCache(cache, null, composers);
  assert.equal(cache.has("child"), false);
  assert.equal(cache.size, 4);
  // Retiring the presentation and evicting its history do not retire input.
  drafts.close(draft.id);
  finishImport();
  await imported;
  assert.equal(
    composers.child!.draft.text,
    "edited while sidebar writes await",
  );
  assert.deepEqual(composers.child!.draft.images, [image]);
  assert.deepEqual(discarded, []);
});

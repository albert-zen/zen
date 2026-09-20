import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyComposerState,
  editComposer,
} from "../src/renderer/src/composer-state.js";
import {
  handleCompactCommand,
  isCompactCommand,
  requestContextCompaction,
} from "../src/renderer/src/compact-command.js";

test("compact is a standalone command, not ordinary prose or a code block", () => {
  for (const text of ["/compact", "  /compact\n", "/compact extra"])
    assert.equal(isCompactCommand(text), true);
  for (const text of ["explain /compact", "```\n/compact\n```", "/compaction"])
    assert.equal(isCompactCommand(text), false);
});

test("compact deduplicates pending requests and preserves a changed draft on success", async () => {
  let state = editComposer(emptyComposerState(), "/compact");
  let finish!: () => void;
  let calls = 0;
  const options = {
    threadId: "thread-a",
    active: false,
    read: () => state,
    update: (f: (value: typeof state) => typeof state) => {
      state = f(state);
    },
    compact: async (id: string) => {
      assert.equal(id, "thread-a");
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  const pending = handleCompactCommand(options);
  assert.equal(state.compaction?.status, "pending");
  assert.equal(await handleCompactCommand(options), true);
  assert.equal(calls, 1);
  state = editComposer(state, "new draft");
  finish();
  await pending;
  assert.equal(state.draft.text, "new draft");
  assert.equal(state.compaction?.status, "succeeded");
});

test("compact rejects busy, new-thread, arguments and attachments without a request", async () => {
  for (const scenario of ["busy", "new", "arguments", "images"]) {
    let state = editComposer(
      emptyComposerState(),
      scenario === "arguments" ? "/compact now" : "/compact",
    );
    if (scenario === "images")
      state = {
        ...state,
        draft: { ...state.draft, images: [{ id: "image" } as never] },
      };
    const draft = state.draft;
    await handleCompactCommand({
      threadId: scenario === "new" ? null : "thread",
      active: scenario === "busy",
      read: () => state,
      update: (f) => {
        state = f(state);
      },
      compact: async () => {
        assert.fail("must not send");
      },
    });
    assert.equal(state.compaction?.status, "failed");
    assert.equal(state.draft, draft);
    assert.equal(state.submission, null);
  }
});

test("compact consumes only its unchanged command and maps backend failure without losing the draft", async () => {
  for (const fail of [false, true]) {
    let state = editComposer(emptyComposerState(), "/compact");
    await handleCompactCommand({
      threadId: "thread",
      active: false,
      read: () => state,
      update: (f) => {
        state = f(state);
      },
      compact: async () => {
        if (fail)
          throw new Error(
            "compaction_not_available: no eligible completed Turn boundary",
          );
      },
    });
    assert.equal(state.draft.text, fail ? "/compact" : "");
    assert.equal(state.compaction?.status, fail ? "failed" : "succeeded");
    assert.equal(state.submission, null);
  }
});

test("context action shares the command executor without consuming an unrelated draft", async () => {
  let state = editComposer(emptyComposerState(), "Keep this draft");
  let calls = 0;
  await requestContextCompaction({
    threadId: "thread",
    active: false,
    clearCommandDraft: false,
    read: () => state,
    update: (change) => {
      state = change(state);
    },
    compact: async () => {
      calls += 1;
    },
  });

  assert.equal(calls, 1);
  assert.equal(state.draft.text, "Keep this draft");
  assert.equal(state.compaction?.status, "succeeded");
});

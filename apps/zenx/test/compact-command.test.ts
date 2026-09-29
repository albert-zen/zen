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
          throw Object.assign(new Error("private token=secret"), {
            code: "compaction_not_available",
          });
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

test("compaction failures classify only typed codes and never expose raw IPC or private text", async () => {
  for (const [reason, expected] of [
    [
      Object.assign(new Error("secret"), { code: "thread_busy" }),
      /Wait for the current reply/u,
    ],
    [
      Object.assign(new Error("secret"), {
        zenCode: "compaction_not_available",
      }),
      /no new completed conversation/u,
    ],
    [
      new Error(
        "Error invoking remote method 'zenx:protocol:request': token=secret",
      ),
      /Could not confirm/u,
    ],
    [new Error("thread_busy private token=secret"), /Could not confirm/u],
    [{ nested: { token: "secret" } }, /Could not confirm/u],
  ] as const) {
    let state = emptyComposerState();
    await requestContextCompaction({
      threadId: "thread-a",
      active: false,
      clearCommandDraft: false,
      read: () => state,
      update: (change) => {
        state = change(state);
      },
      compact: async () => {
        throw reason;
      },
    });
    assert.equal(state.compaction?.status, "failed");
    assert.match(state.compaction.message, expected);
    assert.doesNotMatch(
      JSON.stringify(state.compaction),
      /secret|invoking remote method/u,
    );
    assert.ok(state.compaction.detail);
  }
});

test("old compaction request cannot replace a newer action on the same thread", async () => {
  let state = emptyComposerState();
  let rejectOld!: (reason: unknown) => void;
  const update = (change: (value: typeof state) => typeof state) => {
    state = change(state);
  };
  const old = requestContextCompaction({
    threadId: "a",
    active: false,
    clearCommandDraft: false,
    read: () => state,
    update,
    compact: () =>
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
  });
  state = { ...state, compaction: undefined };
  await requestContextCompaction({
    threadId: "a",
    active: false,
    clearCommandDraft: false,
    read: () => state,
    update,
    compact: async () => {},
  });
  rejectOld(new Error("token=secret"));
  await old;
  assert.equal(state.compaction?.status, "succeeded");
});

test("failed notice persists through an unrelated draft edit until dismiss or explicit compact retry", async () => {
  let state = emptyComposerState();
  let calls = 0;
  const options = {
    threadId: "thread-a",
    active: false,
    clearCommandDraft: false,
    read: () => state,
    update: (change: (value: typeof state) => typeof state) => {
      state = change(state);
    },
    compact: async () => {
      calls++;
      if (calls === 1) throw new Error("private secret");
    },
  };
  await requestContextCompaction(options);
  assert.equal(calls, 1);
  assert.equal(state.compaction?.status, "failed");
  state = editComposer(state, "Unrelated message");
  assert.equal(state.compaction?.status, "failed");
  await requestContextCompaction(options);
  assert.equal(calls, 2);
  assert.equal(state.compaction?.status, "succeeded");
  assert.equal(state.draft.text, "Unrelated message");
});

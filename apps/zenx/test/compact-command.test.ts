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

test("compaction distinguishes a confirmed pre-commit failure from unknown transport and preserves local details", async () => {
  for (const [reason, expected, detail] of [
    [
      Object.assign(new Error("Thread is running"), { code: "thread_busy" }),
      /Wait for the current reply/u,
      "Thread is running",
    ],
    [
      Object.assign(new Error("Already compacted"), {
        zenCode: "compaction_not_available",
      }),
      /no new completed conversation/u,
      "Already compacted",
    ],
    [
      Object.assign(
        new Error(
          "HTTP 400 invalid_parameter_error: developer is not an allowed role",
        ),
        { data: { zenCode: "compaction_generation_failed" } },
      ),
      /failed.*not.*applied/iu,
      "HTTP 400 invalid_parameter_error: developer is not an allowed role",
    ],
    [
      new Error("Connection closed after dispatch"),
      /Could not confirm/u,
      "Connection closed after dispatch",
    ],
    [
      new Error("thread_busy in free-form text"),
      /Could not confirm/u,
      "thread_busy in free-form text",
    ],
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
    assert.ok(state.compaction.detail?.includes(detail));
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

test("slash command disables original reference only when explicitly requested", async () => {
  let state = editComposer(emptyComposerState(), "/compact --no-reference");
  const flags: boolean[] = [];
  await handleCompactCommand({
    threadId: "private-thread",
    active: false,
    read: () => state,
    update: (change) => {
      state = change(state);
    },
    compact: async (_threadId, includeOriginalReference) => {
      flags.push(includeOriginalReference);
    },
  });
  assert.deepEqual(flags, [false]);
  assert.equal(state.draft.text, "");
});

test("a failed view refresh cannot turn a committed compaction into an unknown outcome", async () => {
  let state = emptyComposerState();
  let calls = 0;
  await requestContextCompaction({
    threadId: "synthetic",
    active: false,
    clearCommandDraft: false,
    read: () => state,
    update: (change) => {
      state = change(state);
    },
    compact: async () => {
      calls++;
    },
    refresh: async () => {
      throw new Error("Snapshot connection closed");
    },
  });
  assert.equal(calls, 1);
  assert.equal(state.compaction?.status, "succeeded");
  assert.match(state.compaction.message, /compacted.*could not refresh/u);
  assert.ok(state.compaction.detail?.includes("Snapshot connection closed"));
});

test("real manual compaction survives native feedback and canonical refresh without losing request draft authority", async (t) => {
  const { ZenAppServer } = await import("../../../src/app-server.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const { AgentRuntime } = await import("../../../src/runtime.js");
  const { ToolEnvironment } = await import("../../../src/tool.js");
  const { ProviderRegistry } =
    await import("../../../src/provider-registry.js");
  const { StaticModelCatalog } = await import("../../../src/model-catalog.js");
  const { InMemoryThreadMetadataStore } =
    await import("../../../src/thread-metadata.js");
  const { applyCompactionStatus } =
    await import("../src/renderer/src/compaction-feedback.js");
  const { reconcileCanonicalAdmission } =
    await import("../src/renderer/src/composer-state.js");
  const { tmpdir } = await import("node:os");
  for (const scenario of [
    "native",
    "canonical",
    "edited",
    "refresh-failure",
    "lost-reply",
    "typed-rejection",
  ] as const) {
    await t.test(scenario, async () => {
      let summaries = 0;
      const server = new ZenAppServer({
        journal: new InMemoryThreadJournal(),
        runtime: new AgentRuntime({
          toolEnvironment: new ToolEnvironment({ runtimes: [] }),
        }),
        providerRegistry: new ProviderRegistry([
          {
            providerProfileId: "synthetic",
            modelCatalog: new StaticModelCatalog([
              { id: "synthetic", isDefault: true, contextWindow: 100_000 },
            ]),
            adapter: {
              provider: "synthetic",
              async *stream(request) {
                if (request.debugContext?.purpose === "compaction") summaries++;
                yield {
                  type: "text_delta" as const,
                  delta: "synthetic answer or summary",
                };
              },
            },
          },
        ]),
        threadMetadata: new InMemoryThreadMetadataStore(),
        defaults: {
          cwd: tmpdir(),
          providerProfileId: "synthetic",
          modelId: "synthetic",
          reasoningEffort: "medium",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        },
        contextCompaction: { includeOriginalReference: false },
      });
      const thread = await server.startThread();
      await (
        await server.startTurn(thread.id, "synthetic input")
      ).done;
      let state = editComposer(emptyComposerState(), "/compact");
      const facts = [...(await server.readThread(thread.id)).items];
      let sequence = 0;
      const unsubscribe = server.subscribe((event) => {
        if (event.type === "context_compaction_status") {
          if (scenario !== "canonical" || event.phase !== "committed")
            state = applyCompactionStatus(state, event, {
              processEpoch: "synthetic-epoch",
              watermark: ++sequence,
            });
        } else if (event.type === "item_completed") {
          facts.push(event.item);
          state = reconcileCanonicalAdmission(state, facts);
        }
      });
      await requestContextCompaction({
        threadId: thread.id,
        active: false,
        clearCommandDraft: true,
        read: () => state,
        update: (change) => {
          state = change(state);
        },
        compact: async () => {
          const result = await server.compactThread(thread.id);
          if (scenario === "edited") {
            state = editComposer(state, "new draft");
            state = editComposer(state, "/compact");
          }
          if (scenario === "typed-rejection")
            throw Object.assign(
              new Error("Synthetic typed no-new-history response"),
              { code: "compaction_not_available" },
            );
          if (scenario === "lost-reply")
            throw new Error(
              "Synthetic reply connection closed after durable commit",
            );
          return result;
        },
        refresh: async () => {
          if (scenario === "refresh-failure")
            throw new Error("Synthetic refresh failure");
          state = reconcileCanonicalAdmission(
            state,
            (await server.readThread(thread.id)).items,
          );
        },
      });
      unsubscribe();
      assert.equal(summaries, 1);
      assert.equal(
        state.compaction?.status,
        scenario === "typed-rejection" ? "failed" : "succeeded",
      );
      assert.equal(state.compactionRequest, undefined);
      assert.equal(
        state.draft.text,
        scenario === "edited" ||
          scenario === "lost-reply" ||
          scenario === "typed-rejection"
          ? "/compact"
          : "",
      );
      if (scenario === "refresh-failure")
        assert.match(state.compaction!.detail!, /Synthetic refresh failure/u);
      if (scenario === "lost-reply")
        assert.match(state.compaction!.detail!, /after durable commit/u);
    });
  }
});

test("late explicit reply or refresh never replaces a newer native compaction observation", async (t) => {
  const { applyCompactionStatus } =
    await import("../src/renderer/src/compaction-feedback.js");
  for (const settlement of [
    "success",
    "refresh-failure",
    "request-failure",
  ] as const) {
    for (const phase of ["pending", "failed", "unknown"] as const) {
      await t.test(`${settlement} / later ${phase}`, async () => {
        let state = editComposer(emptyComposerState(), "/compact");
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached!: () => void;
        const waiting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const explicit = {
          type: "context_compaction_status" as const,
          threadId: "synthetic-thread",
          operationId: "explicit-1",
          initiator: "human" as const,
          coveredThroughItemId: "boundary-1",
          startedAfterItemId: "prefix-1",
          trigger: { reason: "explicit_request" as const },
          contextWindow: 1_000,
          triggerPercent: 80,
          targetPercent: 80,
          agenticEnabled: false,
        };
        const request = requestContextCompaction({
          threadId: explicit.threadId,
          active: false,
          clearCommandDraft: true,
          read: () => state,
          update: (change) => {
            state = change(state);
          },
          compact: async () => {
            state = applyCompactionStatus(state, {
              ...explicit,
              phase: "pending",
            });
            state = applyCompactionStatus(state, {
              ...explicit,
              phase: "committed",
              compactionItemId: "commit-1",
            });
            if (settlement === "request-failure") {
              reached();
              await held;
              throw new Error("Synthetic late lost reply");
            }
          },
          refresh: async () => {
            reached();
            await held;
            if (settlement === "refresh-failure")
              throw new Error("Synthetic late refresh failure");
          },
        });
        await waiting;
        state = editComposer(state, "new input");
        const automatic = {
          ...explicit,
          operationId: "automatic-2",
          initiator: "automatic" as const,
          coveredThroughItemId: "boundary-2",
          startedAfterItemId: "prefix-2",
          trigger: {
            reason: "next_turn_estimate" as const,
            estimatedInputTokens: 810,
            thresholdTokens: 800,
          },
        };
        state = applyCompactionStatus(state, {
          ...automatic,
          phase: "pending",
        });
        if (phase !== "pending")
          state = applyCompactionStatus(state, { ...automatic, phase });
        const newer = state.compaction;
        release();
        await request;
        assert.equal(state.compaction, newer);
        assert.equal(state.compaction?.operationId, "automatic-2");
        assert.equal(state.compactionRequest, undefined);
        assert.equal(state.draft.text, "new input");
      });
    }
  }
});

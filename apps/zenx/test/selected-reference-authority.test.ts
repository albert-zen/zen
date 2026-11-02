import assert from "node:assert/strict";
import test from "node:test";
import { compileSelectedReferenceInput } from "../../../src/selected-reference-input.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { referenceMessage } from "../src/renderer/src/reference-draft.js";
import { invokeModelToolFacade } from "../src/main/capabilities/model-tool-facade.js";

test("real generated selected message refs reach native dispatch without bypassing its current permission check", async () => {
  const item = {
    type: "user_message" as const,
    id: "input",
    threadId: "owner",
    turnId: "turn",
    createdAt: "2026-10-27T02:00:00Z",
    clientId: "submission",
    text: referenceMessage(
      "\uFFFC",
      [
        {
          kind: "message",
          name: "Source",
          cwd: "/tmp/source",
          threadId: "source-thread",
          id: "source-item",
          excerpt: "exact",
          position: 0,
        },
      ],
      "submission",
    ),
  };
  const provenance = compileSelectedReferenceInput(item, [])!.referenceBindings;
  let checked = false;
  await assert.rejects(
    invokeModelToolFacade({
      references: new ModelReferenceRegistry(),
      epoch: "current",
      invocation: {
        name: "zenx_threads_read",
        callId: "call",
        arguments: { ref: "s1" },
        threadId: "owner",
        cwd: "/tmp",
        signal: new AbortController().signal,
        modelReferences: provenance,
      },
      dispatch: async (invocation) => {
        checked = true;
        assert.equal(invocation.arguments.threadId, "source-thread");
        assert.equal(invocation.arguments.itemId, "source-item");
        throw new Error("native current permission denied");
      },
    }),
    /native current permission denied/,
  );
  assert.equal(checked, true);
});

// Exercise the real reader against a cold native Host journal, including results
// larger than one public_item_json chunk. Only the in-process transport is adapted.
test("page source refs read exact native user, reasoning, call and result Items including continuations", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createHostedAppServer } = await import("../../cli/src/host.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const { ZenXSelfControlCapabilityPackage } =
    await import("../src/main/capabilities/self-control-package.js");
  const { ZenXProjectProjection } =
    await import("../src/main/project-projection.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-page-quote-reader-"));
  const journal = new InMemoryThreadJournal();
  const options = {
    toolPresentation: "direct" as const,
    cwd: root,
    dataDirectory: root,
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never" as const,
    provider: { type: "fake" as const },
    journal,
  };
  const seed = createHostedAppServer(options);
  const source = await seed.startThread();
  await seed.closeProviderTransport();
  const common = {
    threadId: source.id,
    turnId: "source-turn",
    createdAt: "2026-11-02T02:00:00Z",
  };
  const originals = [
    {
      ...common,
      type: "user_message" as const,
      id: "source-user",
      text: "Complete original user question",
    },
    {
      ...common,
      type: "reasoning" as const,
      id: "source-reason",
      summary: "Complete public reasoning",
    },
    {
      ...common,
      type: "tool_call" as const,
      id: "source-call",
      callId: "tool-call",
      name: "shell",
      arguments: { command: "printf synthetic" },
    },
    {
      ...common,
      type: "tool_result" as const,
      id: "source-result",
      callId: "tool-call",
      output: "Exact original result\n".repeat(600),
      exitCode: 0,
    },
  ];
  await journal.append({ ...common, type: "turn_started", id: "source-start" });
  for (const original of originals) await journal.append(original);
  await journal.append({
    ...common,
    type: "turn_completed",
    id: "source-end",
    status: "completed",
  });
  const host = createHostedAppServer(options);
  try {
    const reader = new ZenXSelfControlCapabilityPackage({
      appServer: {
        projectProjection: new ZenXProjectProjection(),
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === "thread/list")
            return {
              data: (
                await host.listThreads({ archived: params.archived as boolean })
              ).map((thread) => ({
                id: thread.id,
                cwd: "cwd" in thread ? thread.cwd : root,
                name: thread.name ?? null,
                status: { type: "idle" },
              })),
              nextCursor: null,
            };
          if (method === "zen/thread/read")
            return { thread: await host.readThread(params.threadId as string) };
          throw new Error(`Unexpected native request ${method}`);
        },
      } as unknown as import("../src/main/capabilities/self-control-package.js").AppServerRequestPort,
    });
    const input = {
      type: "user_message" as const,
      id: "quote",
      threadId: "owner",
      turnId: "owner-turn",
      createdAt: common.createdAt,
      clientId: "submission",
      text: referenceMessage(
        "\uFFFC",
        [
          {
            kind: "text",
            name: "",
            cwd: root,
            excerpt: "selected page text",
            sources: originals.map((original) => ({
              threadId: source.id,
              id: original.id,
            })),
            position: 0,
          },
        ],
        "submission",
      ),
    };
    const provenance = compileSelectedReferenceInput(
      input,
      [],
    )!.referenceBindings;
    const references = new ModelReferenceRegistry();
    for (const [index, original] of originals.entries()) {
      let content = "",
        cursor: string | undefined;
      do {
        const result = await invokeModelToolFacade({
          references,
          epoch: "current",
          invocation: {
            name: "zenx_threads_read",
            callId: `read-${index}`,
            arguments: { ref: `s${index + 1}`, ...(cursor ? { cursor } : {}) },
            threadId: "owner",
            cwd: root,
            signal: new AbortController().signal,
            modelReferences: provenance,
          },
          dispatch: async (invocation) => ({
            exitCode: 0,
            output: JSON.stringify(
              await reader.invoke(invocation.name, invocation),
            ),
          }),
        });
        const page = JSON.parse(result.output);
        content += page.content;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const actual = JSON.parse(content);
      assert.equal(actual.type, original.type);
      if ("output" in original) assert.equal(actual.output, original.output);
      if ("text" in original) assert.equal(actual.text, original.text);
      if ("summary" in original) assert.equal(actual.summary, original.summary);
      if ("arguments" in original)
        assert.deepEqual(actual.arguments, original.arguments);
    }
  } finally {
    await host.closeProviderTransport();
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadWorkspaceInstructions } from "../src/workspace-instructions.js";

const run = promisify(execFile);
test("reads only the containing repository root, not ancestors or cwd-local files", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-instructions-")),
  );
  try {
    const repository = path.join(root, "repo");
    const cwd = path.join(repository, "nested");
    await mkdir(cwd, { recursive: true });
    await run("git", ["init", repository]);
    await writeFile(path.join(root, "AGENTS.md"), "Outside rules");
    await writeFile(path.join(repository, "AGENTS.md"), "Repository rules");
    await writeFile(path.join(cwd, "AGENTS.md"), "Nested rules");
    assert.deepEqual(await loadWorkspaceInstructions(cwd), [
      { path: path.join(repository, "AGENTS.md"), text: "Repository rules" },
    ]);
    assert.deepEqual(await loadWorkspaceInstructions(root), []);
    await rm(path.join(repository, "AGENTS.md"));
    assert.deepEqual(await loadWorkspaceInstructions(cwd), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import type { ContextCompactionConfig } from "../src/context-compaction.js";
import { decodeCanonicalItem } from "../src/item.js";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { AgentRuntime } from "../src/runtime.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
} from "../src/model.js";

function createServer(
  cwd: string,
  journal: JsonlThreadJournal,
  requests: ModelMessage[][],
  contextCompaction: ContextCompactionConfig = {},
  modelOverride?: ModelAdapter,
) {
  const adapter: ModelAdapter = modelOverride ?? {
    provider: "instructions-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "acknowledged" };
    },
  };
  return new ZenAppServer({
    journal,
    contextCompaction,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: adapter.provider,
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd,
      providerProfileId: adapter.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

test("captures root rules at first input and refreshes only after compaction", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-instructions-runtime-")),
  );
  try {
    const repository = path.join(root, "repo");
    const cwd = path.join(repository, "nested");
    await mkdir(cwd, { recursive: true });
    await run("git", ["init", repository]);
    await writeFile(path.join(root, "AGENTS.md"), "OUTSIDE_MUST_NOT_LOAD");
    await writeFile(path.join(cwd, "AGENTS.md"), "CHILD_MUST_NOT_LOAD");
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    const requests: ModelMessage[][] = [];
    const server = createServer(cwd, journal, requests);
    const thread = await server.startThread();
    assert.equal(
      JSON.stringify(thread.items).includes("workspaceInstructions"),
      false,
    );
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "ROOT_CAPTURED_ON_FIRST_INPUT",
    );
    await (
      await server.startTurn(thread.id, "first input")
    ).done;
    const first = requests[0]!;
    assert.match(JSON.stringify(first), /ROOT_CAPTURED_ON_FIRST_INPUT/u);
    assert.doesNotMatch(
      JSON.stringify(first),
      /OUTSIDE_MUST_NOT_LOAD|CHILD_MUST_NOT_LOAD/u,
    );
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "NEW_RULES_FOR_NEW_THREADS",
    );
    await (
      await server.startTurn(thread.id, "second input")
    ).done;
    assert.deepEqual(requests.at(-1)![0], first[0]);
    const restarted = createServer(cwd, journal, requests);
    await (
      await restarted.startTurn(thread.id, "after restart")
    ).done;
    assert.deepEqual(requests.at(-1)![0], first[0]);
    await restarted.compactThread(thread.id);
    await (
      await restarted.startTurn(thread.id, "after compaction")
    ).done;
    const final = requests.at(-1)!;
    assert.match(JSON.stringify(final[0]), /NEW_RULES_FOR_NEW_THREADS/u);
    assert.doesNotMatch(JSON.stringify(final), /ROOT_CAPTURED_ON_FIRST_INPUT/u);
    const items = (await restarted.readThread(thread.id)).items;
    assert.equal(
      items.filter(
        (item) =>
          item.type === "turn_started" &&
          item.workspaceInstructions !== undefined,
      ).length,
      1,
    );
    const fresh = await restarted.startThread();
    await (
      await restarted.startTurn(fresh.id, "fresh thread")
    ).done;
    assert.match(JSON.stringify(requests.at(-1)), /NEW_RULES_FOR_NEW_THREADS/u);
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)),
      /ROOT_CAPTURED_ON_FIRST_INPUT/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary Turns do not reload empty snapshots or historical threads", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-instructions-empty-")),
  );
  try {
    await run("git", ["init", root]);
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    const requests: ModelMessage[][] = [];
    const server = createServer(root, journal, requests);
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "without rules")
    ).done;
    await writeFile(path.join(root, "AGENTS.md"), "LATE_RULES");
    await (
      await server.startTurn(thread.id, "still without rules")
    ).done;
    assert.doesNotMatch(JSON.stringify(requests), /LATE_RULES/u);
    const metadata = thread.items.find(
      (item) => item.type === "thread_metadata",
    )!;
    const { workspaceInstructionPolicy: _policy, ...oldMetadata } = metadata;
    await journal.append({
      ...oldMetadata,
      id: "historical-metadata",
      threadId: "historical",
    });
    const restarted = createServer(root, journal, requests);
    await (
      await restarted.startTurn("historical", "old empty thread")
    ).done;
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /LATE_RULES/u);
    assert.deepEqual(
      compileModelMessages((await restarted.readThread("historical")).items)[0],
      { role: "user", content: [{ type: "text", text: "old empty thread" }] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid and oversized rules fail first-input admission without starting a Turn", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-instructions-error-")),
  );
  try {
    await run("git", ["init", root]);
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    const requests: ModelMessage[][] = [];
    const server = createServer(root, journal, requests);
    const filename = path.join(root, "AGENTS.md");
    await writeFile(filename, Buffer.from([0xff]));
    const thread = await server.startThread();
    await assert.rejects(
      server.startTurn(thread.id, "invalid rules"),
      /Cannot read workspace instructions/u,
    );
    await writeFile(filename, "x".repeat(128 * 1024 + 1));
    await assert.rejects(
      server.startTurn(thread.id, "oversized rules"),
      /exceeds the .*budget/u,
    );
    assert.equal(requests.length, 0);
    assert.equal(
      (await server.readThread(thread.id)).items.some(
        (item) => item.type === "turn_started",
      ),
      false,
    );
    await writeFile(filename, "VALID_RULES_AFTER_EXPLICIT_RETRY");
    await (
      await server.startTurn(thread.id, "retry")
    ).done;
    assert.match(JSON.stringify(requests), /VALID_RULES_AFTER_EXPLICIT_RETRY/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction budgets the newly read rules, even without retained history", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-instructions-budget-")),
  );
  try {
    await run("git", ["init", root]);
    await writeFile(path.join(root, "AGENTS.md"), "small initial rules");
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    const server = createServer(root, journal, [], { targetPercent: 1 });
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "hello")
    ).done;
    await writeFile(path.join(root, "AGENTS.md"), "rule ".repeat(1000));
    await assert.rejects(
      server.compactThread(thread.id),
      /compaction retained Items exceed/u,
    );
    assert.equal(
      (await server.readThread(thread.id)).items.some(
        (item) => item.type === "context_compaction",
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical restore rejects snapshots exceeding the original-text budget", () => {
  assert.throws(
    () =>
      decodeCanonicalItem({
        id: "start",
        threadId: "thread",
        turnId: "turn",
        createdAt: "2026-09-10T00:00:00Z",
        type: "turn_started",
        workspaceInstructions: [
          { path: "/repo/AGENTS.md", text: "x".repeat(128 * 1024 + 1) },
        ],
      }),
    /workspace instruction budget/u,
  );
});

test("failed reload preserves context; deletion commits empty rules and survives restart", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-refresh-deleted-")),
  );
  try {
    await run("git", ["init", root]);
    const filename = path.join(root, "AGENTS.md");
    await writeFile(filename, "ORIGINAL_RULE");
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    const requests: ModelMessage[][] = [];
    const server = createServer(root, journal, requests);
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "first")
    ).done;
    await writeFile(filename, Buffer.from([0xff]));
    await assert.rejects(
      server.compactThread(thread.id),
      /Cannot read workspace instructions/u,
    );
    let items = (await server.readThread(thread.id)).items;
    assert.equal(
      items.some((item) => item.type === "context_compaction"),
      false,
    );
    assert.match(JSON.stringify(compileModelMessages(items)), /ORIGINAL_RULE/u);
    await rm(filename);
    await server.compactThread(thread.id);
    items = (await server.readThread(thread.id)).items;
    const compact = items.findLast(
      (item) => item.type === "context_compaction",
    );
    assert.deepEqual(compact?.workspaceInstructions, []);
    assert.throws(
      () =>
        decodeCanonicalItem({
          ...compact,
          workspaceInstructions: [
            { path: filename, text: "x".repeat(128 * 1024 + 1) },
          ],
        }),
      /workspace instruction budget/u,
    );
    const restarted = createServer(root, journal, requests);
    await writeFile(filename, "ONLY_AFTER_NEXT_COMPACTION");
    await (
      await restarted.startTurn(thread.id, "after restart")
    ).done;
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)),
      /ORIGINAL_RULE|ONLY_AFTER_NEXT_COMPACTION/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentic compaction refreshes rules before the next sample and clears deleted rules", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-refresh-agentic-")),
  );
  try {
    await run("git", ["init", root]);
    const filename = path.join(root, "AGENTS.md");
    await writeFile(filename, "BEFORE_AGENTIC");
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    let samples = 0;
    const adapter: ModelAdapter = {
      provider: "instructions-test",
      async *stream(request): AsyncIterable<ModelEvent> {
        samples++;
        const content = JSON.stringify(request.messages);
        if (samples === 1) {
          assert.match(content, /BEFORE_AGENTIC/u);
          await writeFile(filename, "AFTER_AGENTIC");
        } else if (samples === 2) {
          assert.match(content, /AFTER_AGENTIC/u);
          assert.doesNotMatch(content, /BEFORE_AGENTIC/u);
          await rm(filename);
        } else {
          assert.doesNotMatch(content, /BEFORE_AGENTIC|AFTER_AGENTIC/u);
          yield { type: "text_delta", delta: "done" };
          return;
        }
        yield {
          type: "tool_call",
          name: "compact_context",
          callId: `compact-${samples}`,
          arguments: { text: "continue the task" },
        };
      },
    };
    const server = createServer(
      root,
      journal,
      [],
      { agenticEnabled: true },
      adapter,
    );
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "perform task")
    ).done;
    assert.equal(samples, 3);
    const items = (await server.readThread(thread.id)).items;
    assert.deepEqual(
      items
        .filter((item) => item.type === "context_compaction")
        .map((item) => item.workspaceInstructions?.map((file) => file.text)),
      [["AFTER_AGENTIC"], []],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic compaction rereads rules after generating its summary", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-refresh-auto-")),
  );
  try {
    await run("git", ["init", root]);
    const filename = path.join(root, "AGENTS.md");
    await writeFile(filename, "AUTO_ORIGINAL");
    const journal = new JsonlThreadJournal(path.join(root, "journal"));
    let samples = 0;
    const adapter: ModelAdapter = {
      provider: "instructions-test",
      async *stream(): AsyncIterable<ModelEvent> {
        samples++;
        if (samples === 2) await writeFile(filename, "AUTO_AFTER_SUMMARY");
        yield {
          type: "text_delta",
          delta: samples === 2 ? "summary" : "answer",
        };
        if (samples === 1)
          yield { type: "usage", inputTokens: 30000, outputTokens: 1 };
      },
    };
    const server = createServer(root, journal, [], {}, adapter);
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "first")
    ).done;
    const items = (await server.readThread(thread.id)).items;
    assert.equal(samples, 2);
    assert.deepEqual(
      items
        .findLast((item) => item.type === "context_compaction")
        ?.workspaceInstructions?.map((file) => file.text),
      ["AUTO_AFTER_SUMMARY"],
    );
    assert.match(
      JSON.stringify(compileModelMessages(items)),
      /AUTO_AFTER_SUMMARY/u,
    );
    assert.doesNotMatch(
      JSON.stringify(compileModelMessages(items)),
      /AUTO_ORIGINAL/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

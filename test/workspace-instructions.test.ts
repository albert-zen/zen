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
) {
  const adapter: ModelAdapter = {
    provider: "instructions-test",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "acknowledged" };
    },
  };
  return new ZenAppServer({
    journal,
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

test("captures root rules at first input and reuses the journal snapshot through edits, restart and compaction", async () => {
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
    assert.deepEqual(final[0], first[0]);
    assert.equal(
      JSON.stringify(final).split("ROOT_CAPTURED_ON_FIRST_INPUT").length - 1,
      1,
    );
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

test("empty first snapshots and historical threads never acquire later rules", async () => {
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

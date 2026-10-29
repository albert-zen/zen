import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundShellPhase,
  shellListing,
} from "../src/renderer/src/background-shell-state.js";
import type { ShellSessionSummary } from "../../../src/shell-session.js";
import { ShellToolRuntime, ToolEnvironment } from "../../../src/tool.js";
import { ShellPanelService } from "../src/main/shell-panel-service.js";
import { openShellTarget } from "../src/renderer/src/shell-target-navigation.js";
import { ThreadSidebarController } from "../src/renderer/src/thread-sidebar-controller.js";

const session: ShellSessionSummary = {
  taskId: "exact-task",
  threadId: "source",
  origin: "agent",
  kind: "command",
  command: "synthetic command",
  cwd: "/tmp",
  createdAt: "2026-10-29T00:00:00.000Z",
  status: "running",
  exitCode: null,
  inputAvailable: false,
  retained: false,
  lifecycle: { foreground: "running", stdio: "open" },
};
test("only confirmed native foreground execution counts as running", () => {
  assert.equal(backgroundShellPhase(session), "running");
  assert.equal(
    backgroundShellPhase({ ...session, lifecycle: undefined }),
    "starting",
  );
  assert.equal(
    backgroundShellPhase({ ...session, status: "queued" }),
    "queued",
  );
  assert.equal(
    backgroundShellPhase({ ...session, status: "cancellation_unconfirmed" }),
    "unconfirmed",
  );
  assert.equal(
    backgroundShellPhase({ ...session, status: "completed" }),
    "ended",
  );
  assert.equal(
    backgroundShellPhase({
      ...session,
      lifecycle: {
        foreground: "exited",
        foreground_exit_code: 0,
        foreground_signal: null,
        stdio: "open",
      },
    }),
    "output",
  );
});
test("missing, malformed, duplicate, cross-thread and fork-inherited observations fail closed", () => {
  const listing = {
    host: "local",
    sessions: [session],
    cwd: "/tmp",
    canCreate: false,
  };
  assert.equal(shellListing(listing, "source").sessions.length, 1);
  for (const value of [
    null,
    {},
    { ...listing, sessions: [session, session] },
    { ...listing, sessions: [{ ...session, status: "invented" }] },
  ])
    assert.throws(() => shellListing(value, "source"));
  assert.throws(() => shellListing(listing, "fork"));
});
test("exact Terminal navigation uses the existing resource-owner tab; no input, creation or model calls", async () => {
  const sidebar = new ThreadSidebarController();
  const requests: unknown[] = [];
  const target = { threadId: "source", taskId: session.taskId };
  assert.equal(
    await openShellTarget({
      target,
      owner: { kind: "thread", id: "viewport" },
      sidebar,
      isCurrent: () => true,
      api: {
        request: async (request) => {
          requests.push(request);
          return { session, output: "", cursor: 0, truncated: false };
        },
      },
    }),
    true,
  );
  assert.deepEqual(requests, [{ operation: "read", ...target }]);
  assert.deepEqual(sidebar.get("viewport")?.tabs, [
    { kind: "terminal", resourceThreadId: "source" },
  ]);
  assert.equal(sidebar.get("viewport")?.selectedTab, "terminal:@source");
  assert.equal(sidebar.get("source"), undefined);
  await assert.rejects(
    openShellTarget({
      target,
      owner: { kind: "thread", id: "fork" },
      sidebar,
      isCurrent: () => true,
      api: {
        request: async () => ({
          session: { ...session, threadId: "other" },
          output: "",
          cursor: 0,
          truncated: false,
        }),
      },
    }),
    /not found/,
  );
  assert.equal(sidebar.get("fork"), undefined);
  assert.equal(
    await openShellTarget({
      target,
      owner: { kind: "thread", id: "stale" },
      sidebar,
      isCurrent: () => false,
      api: {
        request: async () => ({
          session,
          output: "",
          cursor: 0,
          truncated: false,
        }),
      },
    }),
    false,
  );
  assert.equal(sidebar.get("stale"), undefined);
});
test("actual Shell command outlives its returned call, refreshes to exit without another model turn, and is never owned by fork", async () => {
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { yieldTimeMs: 5 },
  });
  const service = new ShellPanelService(
    {
      readThreadSummary: async (id: string) => ({
        threadId: id,
        currentMetadata: { cwd: process.cwd(), sandbox: "danger-full-access" },
        archived: false,
        status: "idle",
      }),
    } as any,
    tools,
  );
  try {
    const result = await tools.execute(
      tools.prepare({
        name: "shell",
        callId: "completed-call",
        threadId: "source",
        cwd: process.cwd(),
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>process.exit(7),350)"`,
        },
        signal: new AbortController().signal,
      }),
    );
    const listing = shellListing(
      await service.request({ operation: "list", threadId: "source" }),
      "source",
    );
    assert.equal(listing.sessions.length, 1);
    assert.equal(
      listing.sessions[0]!.taskId,
      (result.structuredContent as { task_id: string }).task_id,
    );
    assert.equal(backgroundShellPhase(listing.sessions[0]!), "running");
    assert.equal(
      shellListing(
        await service.request({ operation: "list", threadId: "fork" }),
        "fork",
      ).sessions.length,
      0,
    );
    await assert.rejects(
      service.request({
        operation: "read",
        threadId: "fork",
        taskId: listing.sessions[0]!.taskId,
      }),
      /not found/,
    );
    const deadline = Date.now() + 5000;
    let latest = listing.sessions[0]!;
    while (backgroundShellPhase(latest) !== "ended" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      latest = shellListing(
        await service.request({ operation: "list", threadId: "source" }),
        "source",
      ).sessions[0]!;
    }
    assert.equal(backgroundShellPhase(latest), "ended");
    assert.equal(latest.exitCode, 7);
    const read = await service.request({
      operation: "read",
      threadId: "source",
      taskId: latest.taskId,
    });
    assert.equal(
      (read as { session: ShellSessionSummary }).session.exitCode,
      7,
    );
  } finally {
    await tools.close();
  }
});

test("a completed real Turn and its actual fork keep live Shell ownership only on the source", async () => {
  const { ZenAppServer } = await import("../../../src/app-server.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const { InMemoryThreadMetadataStore } =
    await import("../../../src/thread-metadata.js");
  const { ProviderRegistry } =
    await import("../../../src/provider-registry.js");
  const { StaticModelCatalog } = await import("../../../src/model-catalog.js");
  const { AgentRuntime } = await import("../../../src/runtime.js");
  let samples = 0;
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { yieldTimeMs: 5 },
  });
  const app = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({ toolEnvironment: tools }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fake",
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32768 },
        ]),
        adapter: {
          provider: "fake",
          async *stream() {
            if (samples++ === 0)
              yield {
                type: "tool_call" as const,
                callId: "background",
                name: "shell",
                arguments: {
                  command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>process.exit(0),1000)"`,
                },
              };
            else
              yield {
                type: "text_delta" as const,
                delta:
                  "Synthetic final answer; the command continues separately.",
              };
          },
        },
      },
    ]),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "fake",
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const service = new ShellPanelService(app, tools);
  try {
    const source = await app.startThread();
    await (
      await app.startTurn(source.id, "Synthetic background ownership fixture")
    ).done;
    const sourceSnapshot = await app.readThread(source.id);
    assert.equal(sourceSnapshot.items.at(-1)?.type, "turn_completed");
    const sourceSessions = shellListing(
      await service.request({ operation: "list", threadId: source.id }),
      source.id,
    ).sessions;
    assert.equal(sourceSessions.length, 1);
    assert.equal(backgroundShellPhase(sourceSessions[0]!), "running");
    const fork = await app.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert(
      fork.items.some((item) => item.type === "tool_result"),
      "fork retains historical tool receipt",
    );
    assert.deepEqual(
      shellListing(
        await service.request({ operation: "list", threadId: fork.id }),
        fork.id,
      ).sessions,
      [],
    );
    await assert.rejects(
      service.request({
        operation: "read",
        threadId: fork.id,
        taskId: sourceSessions[0]!.taskId,
      }),
      /not found/,
    );
    const deadline = Date.now() + 5000;
    let current = sourceSessions[0]!;
    while (backgroundShellPhase(current) !== "ended" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = shellListing(
        await service.request({ operation: "list", threadId: source.id }),
        source.id,
      ).sessions[0]!;
    }
    assert.equal(backgroundShellPhase(current), "ended");
    assert.equal(current.exitCode, 0);
    assert.equal(
      samples,
      2,
      "completion observation and fork never sample another model turn",
    );
  } finally {
    await tools.close();
    await app.closeRuntimeConfiguration();
  }
});

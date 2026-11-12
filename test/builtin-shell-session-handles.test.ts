import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  trustedModelReferenceBindings,
  type ModelReferenceBinding,
} from "../src/model-references.js";
import type { ModelAdapter, ModelEvent } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import type {
  ShellSessionRead,
  ShellSessionSummary,
} from "../src/shell-session.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { FileTraceStore } from "../src/trace.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolInvocation,
} from "../src/tool.js";

function invoke(
  threadId: string,
  name: string,
  args: Record<string, unknown> = {},
  history?: readonly ModelReferenceBinding[],
): ToolInvocation {
  return {
    name,
    arguments: args,
    callId: "native-host-call",
    cwd: os.tmpdir(),
    threadId,
    sandbox: "danger-full-access",
    signal: new AbortController().signal,
    ...(history === undefined
      ? {}
      : {
          modelReferences: history,
          canonicalToolCallId: "accepted-reader-call",
        }),
  };
}
function terminalFixture(trace?: FileTraceStore) {
  const data = new Set<(text: string) => void>();
  const exits = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  let kills = 0,
    writes = 0;
  const shell = new ShellToolRuntime({
    pty: {
      async spawn() {
        return {
          write() {
            writes++;
          },
          resize() {},
          onData(listener) {
            data.add(listener);
            return {
              dispose() {
                data.delete(listener);
              },
            };
          },
          onExit(listener) {
            exits.add(listener);
            return {
              dispose() {
                exits.delete(listener);
              },
            };
          },
          kill() {
            kills++;
            queueMicrotask(() => {
              for (const exit of exits) exit({ exitCode: 0 });
            });
          },
        };
      },
    },
  });
  const tools = new ToolEnvironment({
    shellSessions: true,
    runtimes: [shell],
    taskOptions: { yieldTimeMs: 1 },
    ...(trace ? { trace } : {}),
  });
  return {
    tools,
    emit(text: string) {
      for (const listener of data) listener(text);
    },
    kills: () => kills,
    writes: () => writes,
    async create(threadId: string) {
      return await tools.execute(
        tools.prepare({
          ...invoke(threadId, "shell"),
          userTerminal: { cols: 80, rows: 24 },
        }),
      );
    },
  };
}

test("actual ModelRequest uses observed human-session refs without gaining terminal control or losing native Trace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-human-session-refs-"));
  const trace = new FileTraceStore(path.join(root, "trace"));
  const fixture = terminalFixture(trace);
  let samples = 0,
    secondWire = "";
  const model: ModelAdapter = {
    provider: "human-session-refs",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (++samples === 1)
        yield {
          type: "tool_call",
          callId: "list-human-session",
          name: "shell_sessions",
          arguments: {},
        };
      else if (samples === 2) {
        secondWire = JSON.stringify({
          messages: request.messages,
          tools: request.tools,
        });
        yield {
          type: "tool_call",
          callId: "read-human-session",
          name: "shell_sessions",
          arguments: { task_id: "t1" },
        };
        yield {
          type: "tool_call",
          callId: "no-human-termination",
          name: "wait",
          arguments: { task_id: "t1", terminate: true },
        };
      } else
        yield {
          type: "text_delta",
          delta: "The terminal remains human controlled.",
        };
    },
  };
  const app = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({ toolEnvironment: fixture.tools, trace }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "model", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  let restarted: ReturnType<typeof terminalFixture> | undefined;
  try {
    const thread = await app.startThread();
    const created = await fixture.create(thread.id);
    assert.equal(
      trustedModelReferenceBindings(created),
      undefined,
      "a human gesture invents no accepted model task",
    );
    const native = (created.structuredContent as { task_id: string }).task_id;
    const literal =
      "human output 12345678-1234-1234-1234-123456789abc /tmp/raw.ts taskId: literal";
    fixture.emit(literal);
    await (
      await app.startTurn(
        thread.id,
        "Inspect my current terminal without controlling it.",
      )
    ).done;
    assert.ok(secondWire.includes('taskId\\\":\\\"t1'));
    assert.ok(!secondWire.includes(native));
    assert.ok(!secondWire.includes(thread.id));
    const snapshot = await app.readThread(thread.id);
    const listed = snapshot.items.find(
      (item) =>
        item.type === "tool_result" && item.callId === "list-human-session",
    );
    const reader = snapshot.items.find(
      (item) =>
        item.type === "tool_call" && item.callId === "list-human-session",
    );
    assert.ok(listed?.type === "tool_result" && reader?.type === "tool_call");
    const binding = listed.referenceBindings![0]!;
    assert.equal(binding.ref, "t1");
    assert.equal(binding.kind, "shell-session");
    assert.deepEqual(binding.value, {
      taskId: native,
      sourceToolCallId: reader.id,
    });
    const publicSummary = JSON.parse(listed.output)[0];
    assert.equal(publicSummary.origin, "user");
    assert.equal(publicSummary.threadId, undefined);
    const read = snapshot.items.find(
      (item) =>
        item.type === "tool_result" && item.callId === "read-human-session",
    );
    const denied = snapshot.items.find(
      (item) =>
        item.type === "tool_result" && item.callId === "no-human-termination",
    );
    assert.ok(read?.type === "tool_result");
    assert.equal((JSON.parse(read.output) as ShellSessionRead).output, literal);
    assert.ok(
      denied?.type === "tool_result" &&
        denied.exitCode !== 0 &&
        denied.output.includes("Human terminals are read-only"),
    );
    assert.equal(fixture.kills(), 0);
    assert.equal(fixture.writes(), 0);
    assert.equal(
      fixture.tools.taskManager.readShellSession(thread.id, native).session
        .taskId,
      native,
    );
    assert.equal(
      fixture.tools.taskManager.readShellSession(thread.id, native).session
        .threadId,
      thread.id,
    );
    const raw = (await trace.read(thread.id)).records.find(
      (record) =>
        record.type === "tool_result_observed" &&
        (record.data as { captureLayer?: string; callId?: string })
          .captureLayer === "shell-session-observation-before-projection" &&
        (record.data as { callId?: string }).callId === "list-human-session",
    )!;
    assert.ok(raw);
    const source = JSON.parse(
      Buffer.from(
        await trace.readArtifact(
          raw.artifacts.find((artifact) => artifact.name === "result_json")!
            .ref,
        ),
      ).toString("utf8"),
    );
    const sourceSummary = JSON.parse(source.output)[0];
    assert.equal(sourceSummary.taskId, native);
    assert.equal(sourceSummary.threadId, thread.id);
    await assert.rejects(
      fixture.tools.execute(
        fixture.tools.prepare(
          invoke("foreign-thread", "shell_sessions", { task_id: "t1" }, [
            binding,
          ]),
        ),
      ),
      /unavailable|not found/u,
    );
    const abort = new AbortController();
    const waiting = fixture.tools.waitRuntime.execute({
      ...invoke(thread.id, "wait", { task_id: "t1", yield_time_ms: 10000 }, [
        binding,
      ]),
      signal: abort.signal,
    });
    abort.abort(new Error("Agent observation interrupted"));
    await assert.rejects(waiting, /Agent observation interrupted/u);
    assert.equal(fixture.kills(), 0);
    assert.equal(
      fixture.tools.taskManager.readShellSession(thread.id, native).session
        .status,
      "running",
    );
    const increment = await fixture.tools.waitRuntime.execute(
      invoke(thread.id, "wait", { task_id: "t1", yield_time_ms: 1 }, [binding]),
    );
    assert.ok(
      increment.output.includes(literal),
      "read/failed terminate/aborted observation never drains output",
    );
    await fixture.tools.taskManager.stopShellSession(thread.id, native);
    await fixture.tools.waitRuntime.execute(
      invoke(thread.id, "wait", { task_id: "t1", yield_time_ms: 100 }, [
        binding,
      ]),
    );
    const retained = await fixture.tools.execute(
      fixture.tools.prepare(
        invoke(thread.id, "shell_sessions", { task_id: "t1" }, [binding]),
      ),
    );
    assert.equal(JSON.parse(retained.output).session.taskId, "t1");
    assert.equal(JSON.parse(retained.output).session.retained, true);
    await assert.rejects(
      fixture.tools.waitRuntime.execute(
        invoke(thread.id, "wait", { task_id: "t1", yield_time_ms: 1 }, [
          binding,
        ]),
      ),
      /not found/u,
    );
    await fixture.tools.close();
    restarted = terminalFixture();
    const newNative = (
      (await restarted.create(thread.id)).structuredContent as {
        task_id: string;
      }
    ).task_id;
    assert.notEqual(newNative, native);
    const next = await restarted.tools.execute(
      restarted.tools.prepare(
        invoke(thread.id, "shell_sessions", {}, [binding]),
      ),
    );
    assert.equal(JSON.parse(next.output)[0].taskId, "t2");
    await assert.rejects(
      restarted.tools.execute(
        restarted.tools.prepare(
          invoke(thread.id, "shell_sessions", { task_id: "t1" }, [binding]),
        ),
      ),
      /not found/u,
    );
    await assert.rejects(
      restarted.tools.waitRuntime.execute(
        invoke(thread.id, "wait", { task_id: "t1", yield_time_ms: 1 }, [
          binding,
        ]),
      ),
      /not found/u,
    );
    assert.equal(restarted.kills(), 0);
  } finally {
    await restarted?.tools.close();
    await fixture.tools.close();
    await app.closeRuntimeConfiguration();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual Agent shell session reuses its exact task ref at full execution capacity", async () => {
  const tools = new ToolEnvironment({
    shellSessions: true,
    runtimes: [new ShellToolRuntime()],
    taskOptions: { maxRunningTasks: 1, yieldTimeMs: 1 },
  });
  try {
    const task = await tools.execute(
      tools.prepare(
        invoke(
          "agent-owner",
          "shell",
          {
            command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},30000)"`,
          },
          [],
        ),
      ),
    );
    const binding = trustedModelReferenceBindings(task)![0]!;
    const native = (task.structuredContent as { task_id: string }).task_id;
    assert.equal(binding.kind, "task");
    const list = await tools.execute(
      tools.prepare(invoke("agent-owner", "shell_sessions", {}, [binding])),
    );
    const sessions = JSON.parse(list.output) as Array<
      Omit<ShellSessionSummary, "threadId"> & { threadId?: string }
    >;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.taskId, binding.ref);
    assert.equal(sessions[0]!.threadId, undefined);
    assert.equal(sessions[0]!.origin, "agent");
    assert.deepEqual(trustedModelReferenceBindings(list), [binding]);
    assert.equal(tools.taskManager.activeTaskCount, 1);
    const stopped = await tools.waitRuntime.execute(
      invoke(
        "agent-owner",
        "wait",
        { task_id: binding.ref, terminate: true, yield_time_ms: 1000 },
        [binding],
      ),
    );
    assert.equal(
      (stopped.structuredContent as { task_id: string }).task_id,
      native,
    );
    assert.equal(
      (stopped.structuredContent as { status: string }).status,
      "cancelled",
    );
  } finally {
    await tools.close();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { ToolEnvironment } from "../src/tool.js";
import { FileTraceStore } from "../src/trace.js";
import { testToolRuntime } from "./tool-fixtures.js";

test("passive Trace acknowledgement cannot insert an await after the final tool dispatch fence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-dispatch-trace-"),
  );
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const original = FileTraceStore.prototype.record;
  FileTraceStore.prototype.record = async function (event) {
    const receipt = await original.call(this, event);
    if (event.type === "tool_invocation_observed") {
      order.push("observation pending");
      entered();
      await gate;
    }
    return receipt;
  };
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
    toolEnvironment: new ToolEnvironment({
      runtimes: [
        testToolRuntime({
          name: "effect",
          execute: async (invocation) => {
            order.push(`body ${invocation.sandbox}`);
            return { output: "synthetic effect", exitCode: 0 };
          },
        }),
      ],
    }),
  });
  try {
    const thread = await host.startThread();
    const turn = await host.startTurn(thread.id, "!tool effect {}");
    await observed;
    await host.setThreadPermissions(thread.id, "read-only");
    order.push("revocation acknowledged");
    release();
    await turn.done;
    assert.equal(order.filter((value) => value.startsWith("body ")).length, 1);
    assert(
      order.indexOf("body danger-full-access") <
        order.indexOf("revocation acknowledged"),
    );
    assert.equal((await host.readThread(thread.id)).sandbox, "read-only");
  } finally {
    release();
    FileTraceStore.prototype.record = original;
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cold Trace identifies the captured local bundle generation and trusted resolved route owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-tool-origin-"));
  const trace = new FileTraceStore(directory);
  const runtime = testToolRuntime({
    name: "same_tool",
    execute: async () => ({ output: "local", exitCode: 0 }),
  });
  const tools = new ToolEnvironment({
    trace,
    bundles: [
      {
        identity: { kind: "plugin", id: "synthetic-bundle-A" },
        tools: [runtime],
      },
    ],
    targetRouter: {
      prepare(invocation, registered) {
        if (invocation.arguments.device === "untrusted-selector")
          return {
            owner: { kind: "external", id: "synthetic-resolved-B" },
            definition: registered!.definition,
            executionMode: "parallel_safe",
            execute: async () => ({ output: "remote", exitCode: 0 }),
          };
        return undefined;
      },
    },
  });
  try {
    for (const [callId, args] of [
      ["local", {}],
      ["remote", { device: "untrusted-selector" }],
    ] as const) {
      await tools.execute(
        tools.prepare({
          name: "same_tool",
          arguments: args,
          callId,
          canonicalToolCallId: `${callId}-item`,
          threadId: "synthetic",
          cwd: directory,
          signal: new AbortController().signal,
          outputAudience: "program",
          task: { waitForCompletion: true },
        }),
      );
    }
    await tools.close();
    const records = (
      await new FileTraceStore(directory).read("synthetic")
    ).records.filter((record) => record.type === "tool_invocation_observed");
    const details = records.map(
      (record) => (record.data as { details: Record<string, unknown> }).details,
    );
    assert.deepEqual(details[0]?.owner, {
      kind: "plugin",
      id: "synthetic-bundle-A",
    });
    assert.equal(details[0]?.dispatch, "local");
    assert.equal(typeof details[0]?.registrationGeneration, "string");
    assert.deepEqual(details[1]?.owner, {
      kind: "external",
      id: "synthetic-resolved-B",
    });
    assert.equal(details[1]?.dispatch, "routed");
    assert.equal(details[1]?.registrationGeneration, undefined);
  } finally {
    await tools.close();
    await rm(directory, { recursive: true, force: true });
  }
});

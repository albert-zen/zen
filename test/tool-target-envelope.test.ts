import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import type { JsonValue } from "../src/item.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter } from "../src/model.js";
import {
  parseRemoteToolExecuteRequest,
  parseRemoteToolResult,
} from "../src/protocol/native/remote-tool-wire.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  MAX_STRUCTURED_TOOL_RESULT_BYTES,
  normalizeToolExecutionResult,
  ToolEnvironment,
  type ToolExecutionResult,
  type ToolInvocation,
  type ToolRuntime,
  type ToolTargetRoute,
} from "../src/tool.js";
import {
  MAX_TOOL_TASK_CONTROL_BYTES,
  TOOL_TASK_CONTENT_TYPE,
} from "../src/tool-task-content.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";

const runtime: ToolRuntime = {
  name: "ordinary",
  remoteExecution: "text-json",
  specification: {
    name: "ordinary",
    description: "Ordinary target fixture",
    inputSchema: { type: "object", properties: {} },
  },
  async execute() {
    throw new Error("Only the target executes this fixture");
  },
};

function invocation(): ToolInvocation {
  return {
    callId: "caller-call",
    canonicalToolCallId: "canonical-call",
    threadId: "caller",
    cwd: process.cwd(),
    name: "ordinary",
    arguments: { device: "peer" },
    signal: new AbortController().signal,
  };
}

function payload(bytes = MAX_STRUCTURED_TOOL_RESULT_BYTES): JsonValue {
  const value = { value: "x".repeat(bytes - 12) };
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
  return value;
}

function envelope(result?: JsonValue): ToolExecutionResult {
  return {
    output: "target result with qualified task receipt",
    exitCode: 0,
    contentType: TOOL_TASK_CONTENT_TYPE,
    structuredContent: {
      status: "completed",
      task_id: "qualified-target-task",
      tool_name: "ordinary",
      lifetime: "host_instance",
      paths: "remote-host",
      exit_code: 0,
      origin: {
        hostId: "target-host",
        processEpoch: "target-epoch",
        workspaceId: "target-workspace",
        threadId: "target-thread",
        toolName: "ordinary",
        toolGeneration: "exact-generation",
      },
      ...(result === undefined
        ? {}
        : { result, result_content_type: "fixture/cards" }),
    },
  };
}

function data(result: ToolExecutionResult): Record<string, JsonValue> {
  return result.structuredContent as Record<string, JsonValue>;
}

function environment(
  result: ToolExecutionResult,
  options: Partial<ToolTargetRoute> = {},
): ToolEnvironment {
  return new ToolEnvironment({
    runtimes: [runtime],
    targetRouter: {
      prepare() {
        return {
          owner: { kind: "external", id: "target-host-adapter" },
          definition: runtime.specification,
          executionMode: "parallel_safe",
          resultEnvelope: "tool-task",
          async execute() {
            return result;
          },
          ...options,
        };
      },
    },
  });
}

for (const bytes of [
  MAX_STRUCTURED_TOOL_RESULT_BYTES - 1,
  MAX_STRUCTURED_TOOL_RESULT_BYTES,
]) {
  test(`target envelope preserves a ${bytes}-byte original structured result`, async () => {
    const original = envelope(payload(bytes));
    assert(
      Buffer.byteLength(JSON.stringify(original.structuredContent)) >
        MAX_STRUCTURED_TOOL_RESULT_BYTES,
    );
    const tools = environment(original);
    try {
      const call = tools.prepare(invocation());
      const result = await tools.execute(call);
      assert.deepEqual(result, original);
      assert(Object.isFrozen(result.structuredContent));
      assert(Object.isFrozen(data(result).result));
      assert(Object.isFrozen(data(result).origin));
      assert.notEqual(data(result).origin, data(original).origin);
      assert.equal(tools.taskManager.ownsInvocation(call.invocation), false);
    } finally {
      await tools.close();
    }
  });
}

test("maximum bounded task identity and origin fit the fixed control budget", async () => {
  const result = envelope(payload());
  const fields = data(result);
  const handlePrefix = "fleet-tool:v1:";
  fields.task_id = handlePrefix + "x".repeat(8192 - handlePrefix.length);
  fields.tool_name = '"'.repeat(512);
  fields.result_content_type = `${"a".repeat(63)}/${"b".repeat(128)}`;
  result.exitCode = Number.MIN_SAFE_INTEGER;
  fields.exit_code = result.exitCode;
  fields.origin = Object.fromEntries(
    Object.keys(fields.origin as Record<string, JsonValue>).map((key) => [
      key,
      '"'.repeat(512),
    ]),
  );
  const { result: _, ...control } = fields;
  assert(
    Buffer.byteLength(JSON.stringify(control)) <= MAX_TOOL_TASK_CONTROL_BYTES,
  );
  assert(
    Buffer.byteLength(
      JSON.stringify({
        ...control,
        status: "cancellation_unconfirmed",
        exit_code: null,
      }),
    ) <= MAX_TOOL_TASK_CONTROL_BYTES,
  );
  const tools = environment(result);
  try {
    assert.deepEqual(await tools.execute(tools.prepare(invocation())), result);
  } finally {
    await tools.close();
  }
});

for (const identity of [
  "é".repeat(128),
  "中".repeat(85) + "x",
  "🙂".repeat(64),
]) {
  test(`legal 256-byte Unicode native origin survives the caller task envelope (${identity.slice(0, 2)})`, async () => {
    assert.equal(Buffer.byteLength(identity), 256);
    const origin = {
      hostId: identity,
      processEpoch: identity,
      workspaceId: identity,
      threadId: identity,
      toolName: identity,
      toolGeneration: identity,
    };
    const nativeResult = parseRemoteToolResult({
      origin,
      admissionId: "unicode-admission",
      taskId: "target-task",
      status: "completed",
      cursor: "target-cursor",
      output: "Unicode origin",
      exitCode: 0,
      contentType: "fixture/cards",
      structuredContent: payload(),
      sourceTruncated: false,
      paths: "remote-host",
    });
    // A larger Unicode identity is rejected by native parsing; it cannot reach
    // target dispatch and later fail only at this caller normalization seam.
    const request = parseRemoteToolExecuteRequest({
      version: 1,
      hostId: identity,
      processEpoch: identity,
      sourceThreadId: "caller",
      workspaceId: identity,
      targetThreadId: identity,
      admissionId: "rt1:1:2:unicode",
      createdAtMs: 1,
      expiresAtMs: 2,
      name: identity,
      toolGeneration: identity,
      arguments: {},
      yieldTimeMs: 1,
      timeoutMs: 1,
      maxOutputBytes: 1,
    });
    assert.throws(
      () =>
        parseRemoteToolExecuteRequest({
          ...request,
          workspaceId: identity + "x",
        }),
      /bounded non-empty string/,
    );
    const handle =
      "fleet-tool:v1:" +
      Buffer.from(
        JSON.stringify({
          device: "peer",
          deviceKey: "a".repeat(64),
          hostId: identity,
          sourceThreadId: "caller",
          workspaceId: identity,
          targetThreadId: identity,
          processEpoch: identity,
          admissionId: nativeResult.admissionId,
          taskId: nativeResult.taskId,
          cursor: nativeResult.cursor,
        }),
      ).toString("base64url");
    assert(handle.length <= 8192);
    const original = envelope(nativeResult.structuredContent);
    data(original).origin = nativeResult.origin as unknown as JsonValue;
    data(original).tool_name = nativeResult.origin.toolName;
    data(original).task_id = handle;
    const tools = environment(original);
    try {
      const result = await tools.execute(tools.prepare(invocation()));
      assert.deepEqual(data(result).origin, origin);
      assert.equal(data(result).task_id, handle);
      assert.deepEqual(data(result).result, nativeResult.structuredContent);
    } finally {
      await tools.close();
    }
  });
}

const invalidCases: {
  name: string;
  change(result: ToolExecutionResult): void;
  error: RegExp;
}[] = [
  {
    name: "non-object control",
    change: (result) => {
      result.structuredContent = "arbitrary JSON";
    },
    error: /control object/,
  },
  {
    name: "non-JSON payload",
    change: (result) => {
      data(result).result = new Map() as never;
    },
    error: /non-JSON object/,
  },
  {
    name: "oversized original payload",
    change: (result) => {
      data(result).result = payload(MAX_STRUCTURED_TOOL_RESULT_BYTES + 1);
    },
    error: /1048576 byte limit/,
  },
  {
    name: "oversized handle",
    change: (result) => {
      data(result).task_id = "x".repeat(8193);
    },
    error: /bounded task task_id/,
  },
  {
    name: "oversized origin",
    change: (result) => {
      (data(result).origin as Record<string, JsonValue>).hostId = "x".repeat(
        513,
      );
    },
    error: /bounded task hostId/,
  },
  {
    name: "oversized control encoding",
    change: (result) => {
      data(result).task_id = '"'.repeat(8192);
    },
    error: /16384 byte limit/,
  },
  {
    name: "unsupported envelope content type",
    change: (result) => {
      result.contentType = "fixture/cards";
    },
    error: /unsupported contentType/,
  },
  {
    name: "invalid original content type",
    change: (result) => {
      data(result).result_content_type = "invalid";
    },
    error: /Invalid structured result contentType/,
  },
  {
    name: "extra control payload",
    change: (result) => {
      data(result).metadata = { arbitrary: "hidden bytes" };
    },
    error: /Unexpected task control field/,
  },
  {
    name: "missing payload type",
    change: (result) => {
      delete data(result).result_content_type;
    },
    error: /both result and result_content_type/,
  },
  {
    name: "malformed status",
    change: (result) => {
      data(result).status = ["completed"];
    },
    error: /Invalid task status/,
  },
  {
    name: "mismatched tool origin",
    change: (result) => {
      data(result).tool_name = "other";
    },
    error: /origin mismatch/,
  },
  {
    name: "mismatched exit code",
    change: (result) => {
      data(result).exit_code = 1;
    },
    error: /Invalid task exit code/,
  },
  {
    name: "remote model content",
    change: (result) => {
      result.modelContent = [{ type: "text", text: "injected" }];
    },
    error: /text\/JSON results only/,
  },
];

for (const fixture of invalidCases) {
  test(`target envelope rejects ${fixture.name}`, async () => {
    const original = envelope({ value: "safe" });
    fixture.change(original);
    const tools = environment(original);
    try {
      await assert.rejects(
        tools.execute(tools.prepare(invocation())),
        fixture.error,
      );
    } finally {
      await tools.close();
    }
  });
}

test("target control budget requires a Host route hint and external adaptation", async () => {
  const original = envelope(payload());
  const unhinted = environment(original, {
    resultEnvelope: undefined,
  } as never);
  const plugin = environment(original, {
    owner: { kind: "plugin", id: "fixture" },
  });
  try {
    await assert.rejects(
      unhinted.execute(unhinted.prepare(invocation())),
      /1048576 byte limit/,
    );
    await assert.rejects(
      plugin.execute(plugin.prepare(invocation())),
      /external-owned Host routes/,
    );
    assert.throws(
      () =>
        normalizeToolExecutionResult(
          {
            output: "ordinary",
            exitCode: 0,
            contentType: "fixture/cards",
            structuredContent: payload(MAX_STRUCTURED_TOOL_RESULT_BYTES + 1),
          },
          { kind: "plugin", id: "fixture" },
        ),
      /1048576 byte limit/,
    );
    assert.throws(
      () =>
        normalizeToolExecutionResult(
          {
            output: "ordinary",
            exitCode: 0,
            contentType: "other/cards",
            structuredContent: {},
          },
          { kind: "plugin", id: "fixture" },
        ),
      /does not own/,
    );
  } finally {
    await unhinted.close();
    await plugin.close();
  }
});

test("target task control hint is captured at prepare and validates running receipts without payloads", async () => {
  const original = envelope();
  data(original).status = "running";
  data(original).exit_code = null;
  let route!: ToolTargetRoute;
  const tools = new ToolEnvironment({
    targetRouter: {
      prepare() {
        route = {
          owner: { kind: "external", id: "host" },
          definition: runtime.specification,
          executionMode: "parallel_safe",
          resultEnvelope: "tool-task",
          execute: async () => original,
        };
        return route;
      },
    },
  });
  try {
    const prepared = tools.prepare(invocation());
    (route as { resultEnvelope?: string }).resultEnvelope = "unsupported";
    assert.deepEqual(await tools.execute(prepared), original);
  } finally {
    await tools.close();
  }
});

test("a maximum target payload survives caller canonical journal persistence and output spooling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-target-envelope-"));
  const journal = new JsonlThreadJournal(path.join(root, "journal"));
  const spool = new ToolOutputSpool({
    rootDirectory: path.join(root, "spool"),
  });
  const original = envelope(payload());
  original.output = "target-text-".repeat(2000);
  const expected = structuredClone(original.structuredContent);
  const tools = environment(original);
  const model: ModelAdapter = {
    provider: "target-envelope-fixture",
    async *stream(request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text_delta", delta: "complete" };
      } else {
        yield {
          type: "tool_call",
          callId: "ordinary-1",
          name: "ordinary",
          arguments: { device: "peer" },
        };
      }
    },
  };
  const server = new ZenAppServer({
    journal,
    runtime: new AgentRuntime({
      toolEnvironment: tools,
      toolOutputSpool: spool,
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture-model", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "fixture-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  try {
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "remote result")
    ).done;
    (data(original).origin as Record<string, JsonValue>).hostId =
      "mutated after execution";
    const items = await journal.read(thread.id);
    const results = items.filter((item) => item.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.exitCode, 0);
    assert.equal(results[0]!.contentType, TOOL_TASK_CONTENT_TYPE);
    assert.deepEqual(results[0]!.structuredContent, expected);
    assert.notEqual(results[0]!.output, original.output);
    assert.match(results[0]!.output, /tool output/);
    assert.equal(
      (await server.readThread(thread.id)).turns[0]?.status,
      "completed",
    );
  } finally {
    await tools.close();
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

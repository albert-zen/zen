import type { ToolTraceCapture } from "../../../src/trace-tool.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { ModelTool } from "../../../src/model.js";
import type { ToolInvocation, ToolExecutionResult } from "../../../src/tool.js";
import {
  ModelReferenceRegistry,
  trustedModelReferenceBindings,
  type ModelReferenceBinding,
} from "../../../src/model-references.js";
import { ZenXHostToolBundle } from "../src/main/capability-tool-executor.js";
import {
  ComputerZenXCapabilityPackage,
  type ZenXComputerBackend,
  type ComputerControlSelector,
} from "../src/main/capabilities/computer-provider.js";
import { ComputerTargetSession } from "../src/main/capabilities/computer-target-session.js";
import { invokeModelToolFacade } from "../src/main/capabilities/model-tool-facade.js";
const UUID = "d7f5f6b1-44d2-4b36-9c49-1171700cc9b3",
  THREAD = "thread-" + UUID,
  OTHER = "other-" + UUID;
const literal = `Quoted user UUID ${UUID}; /tmp/${UUID}.txt; hash abcdef0123456789 unchanged.`;
const signal = () => new AbortController().signal;
type NativeService = {
  invoke(name: string, invocation: ToolInvocation): Promise<unknown>;
};
function syntheticTrace(
  overrides: Partial<ToolTraceCapture>,
): ToolTraceCapture {
  return {
    recordInvocation: async () => {},
    recordReferenceBindings: async () => {},
    recordResult: async () => ({ durability: "degraded", error: "synthetic" }),
    recordAcceptedResult: async () => {},
    write: async () => {},
    end: async () => {},
    flush: async () => {},
    hasObservedResult: () => true,
    hasAcceptedResult: () => false,
    ...overrides,
  };
}
function bridge(
  definitions: readonly ModelTool[],
  service: NativeService,
  history: ModelReferenceBinding[] = [],
  owner = "caller",
) {
  const native: ToolInvocation[] = [],
    trace: Array<{ layer?: string; value: unknown }> = [];
  const bundle = new ZenXHostToolBundle({
    capabilities: {
      definitions: [...definitions],
      generationToken: "same-native-generation",
    },
    send(event) {
      if (event.type !== "capability/invoke") return;
      const invocation = { ...event.invocation, signal: signal() };
      native.push(invocation);
      void service.invoke(invocation.name, invocation).then(
        (value) => {
          const result =
            value && typeof value === "object" && "output" in value
              ? (value as ToolExecutionResult)
              : { output: JSON.stringify(value), exitCode: 0 };
          bundle.handleResult({
            type: "capability/result",
            invocationId: event.invocationId,
            generationToken: event.generationToken,
            ...result,
          });
        },
        (error: Error) =>
          bundle.handleResult({
            type: "capability/result",
            invocationId: event.invocationId,
            generationToken: event.generationToken,
            error: error.message,
          }),
      );
    },
  });
  return {
    bundle,
    native,
    trace,
    history,
    async call(name: string, args: Record<string, unknown>) {
      const tool = bundle.tools.find((tool) => tool.name === name)!;
      const invocation = {
        name,
        callId: `call-${native.length}`,
        canonicalToolCallId: `canonical-${native.length}`,
        threadId: owner,
        cwd: "/synthetic",
        arguments: args,
        signal: signal(),
        modelReferences: structuredClone(history),
        traceOutput: syntheticTrace({
          recordResult: async (value: unknown, layer?: string) => {
            trace.push({ layer, value: structuredClone(value) });
            return {
              durability: "durable",
              locator: {
                threadId: owner,
                recordId: "raw-record",
                callId: "call",
              },
            };
          },
          recordInvocation: async (value: unknown) => {
            trace.push({ layer: "dispatch", value: structuredClone(value) });
          },
          recordReferenceBindings: async (value: unknown) => {
            trace.push({ layer: "bindings", value: structuredClone(value) });
          },
        }),
      };
      const result = await tool.execute(invocation);
      history.push(...(trustedModelReferenceBindings(result) ?? []));
      return JSON.parse(result.output) as any;
    },
  };
}
function computer(count = 2) {
  let observations = 0,
    actions = 0;
  const target = {
    pid: 42,
    applicationName: "Synthetic",
    windowTitle: "Same name",
  };
  const backend = {
    inspect: async () => {
      observations++;
      return {
        platform: "linux",
        observationId: `observation-${observations}-${UUID}`,
        target: { ...target, bundleId: "synthetic.app" },
        controls: Array.from({ length: count }, (_, id) => ({
          selector: {
            observationId: `observation-${observations}-${UUID}`,
            targetId: `target-${id}-${UUID}`,
          },
          role: "button",
          title: "Save",
          enabled: true,
          actions: ["press"],
        })),
        truncated: false,
      };
    },
    press: async (_target: unknown, control: ComputerControlSelector) => {
      assert.equal(
        control.observationId,
        `observation-${observations}-${UUID}`,
      );
      actions++;
      return { target, control };
    },
    setValue: async () => {
      throw Error("unexpected");
    },
  } as unknown as ZenXComputerBackend;
  return {
    service: new ComputerZenXCapabilityPackage(backend),
    target,
    actions: () => actions,
    observations: () => observations,
  };
}
test("real Computer bridge short refs preserve exact pairs, raw Trace, same labels and native stale guard", async () => {
  const fixture = computer(),
    app = bridge(fixture.service.manifest.tools, fixture.service);
  const first = await app.call("computer_inspect", { target: fixture.target });
  assert.notEqual(first.controls[0].ref, first.controls[1].ref);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(UUID));
  await app.call("computer_press", { control: first.controls[1].ref });
  assert.equal(fixture.actions(), 1);
  assert.equal(
    (app.native.at(-1)!.arguments.control as ComputerControlSelector).targetId,
    `target-1-${UUID}`,
  );
  const raw = app.trace.find(
    (entry) => entry.layer === "capability-result-before-model-projection",
  )!.value as ToolExecutionResult;
  assert.match(raw.output, new RegExp(UUID));
  const [a, b] = await Promise.all([
    app.call("computer_inspect", { target: fixture.target }),
    app.call("computer_inspect", { target: fixture.target }),
  ]);
  assert.notEqual(a.controls[0].ref, b.controls[0].ref);
  await assert.rejects(
    app.call("computer_press", { control: a.controls[0].ref }),
    /stale/,
  );
  await app.call("computer_press", { control: b.controls[0].ref });
  assert.equal(fixture.actions(), 2);
});
test("Computer cursor keeps original request target, immutable pages and retirement", async () => {
  const fixture = computer(70),
    app = bridge(fixture.service.manifest.tools, fixture.service);
  const first = await app.call("computer_inspect", { target: fixture.target });
  assert.equal(first.controls.length, 32);
  const second = await app.call("computer_inspect", {
    cursor: first.nextCursor,
  });
  assert.equal(second.controls.length, 32);
  assert.equal(fixture.observations(), 1);
  assert.deepEqual(app.native.at(-1)!.arguments.target, fixture.target);
  await app.call("computer_press", { control: second.controls[0].ref });
  await assert.rejects(
    app.call("computer_inspect", { cursor: first.nextCursor }),
    /stale|expired|invalidated/,
  );
  for (const owner of ["caller", "fork"]) {
    const restarted = bridge(
      fixture.service.manifest.tools,
      fixture.service,
      app.history,
      owner,
    );
    await assert.rejects(
      restarted.call("computer_press", { control: first.controls[0].ref }),
      /retired/,
    );
    assert.equal(restarted.native.length, 0);
  }
});
test("native capture and binding refs preserve exact pair and revoked foreground permission", async () => {
  let selected = 0,
    posted = 0;
  const target = {
    pid: 42,
    applicationName: "Synthetic",
    windowTitle: "Window",
  };
  const session = new ComputerTargetSession({
    request: async (input) => {
      if (input.operation === "select")
        return {
          bindingId: `binding-${++selected}-${UUID}`,
          target,
          windowId: 7,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        };
      if (input.operation === "click") posted++;
      return {};
    },
    close: async () => {},
  });
  const backend = {
    targetSession: session,
    screenshot: async (target: any, abort: AbortSignal, owner: string) =>
      await session.capture(owner, target, abort, async () => ({
        width: 100,
        height: 100,
        artifactPath: `/tmp/${UUID}.png`,
        bytes: 5,
        expiresAt: "later",
      })),
  } as unknown as ZenXComputerBackend;
  const service = new ComputerZenXCapabilityPackage(backend, undefined, true),
    app = bridge(service.manifest.tools, service);
  const old = await app.call("computer_screenshot", { target }),
    fresh = await app.call("computer_screenshot", { target });
  assert.notEqual(old.capture, fresh.capture);
  assert.equal(fresh.artifactPath, `/tmp/${UUID}.png`);
  await assert.rejects(
    app.call("computer_foreground_click", {
      capture: old.capture,
      x: 10,
      y: 10,
    }),
    /current.*captureId/,
  );
  await app.call("computer_foreground_click", {
    capture: fresh.capture,
    x: 10,
    y: 10,
  });
  assert.equal(posted, 1);
  service.setForegroundControlAllowed(false);
  await assert.rejects(
    app.call("computer_foreground_key_press", {
      binding: fresh.binding,
      key: "enter",
    }),
    /enable Foreground/,
  );
});
test("failed raw outcomes and literal UUID text remain exact with resolved input provenance", async () => {
  const registry = new ModelReferenceRegistry(),
    seed = registry.scope("caller");
  const ref = seed.bind(
    "computer",
    "control",
    {
      target: { pid: 42, windowTitle: "Window" },
      control: { observationId: UUID, targetId: UUID },
    },
    "epoch",
  );
  const raw = { output: literal, exitCode: 1 };
  let dispatched = 0;
  const result = await invokeModelToolFacade({
    invocation: {
      name: "computer_press",
      callId: "failed",
      threadId: "caller",
      cwd: "/synthetic",
      arguments: { control: ref },
      signal: signal(),
      modelReferences: seed.newBindings,
    },
    epoch: "epoch",
    references: registry,
    dispatch: async () => {
      dispatched++;
      return raw;
    },
  });
  assert.equal(result.output, literal);
  assert.equal(result.exitCode, 1);
  assert.equal(dispatched, 1);
  assert.deepEqual(trustedModelReferenceBindings(result), seed.newBindings);
});

import {
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";
import {
  readThreadHistory,
  readOriginalThreadHistory,
} from "../../../src/thread-history.js";
function selfControl() {
  const threads = [THREAD, OTHER].map((id) => ({
    id,
    name: "Same label",
    cwd: "/synthetic",
    status: { type: "idle" },
    turns: [],
    items: [] as any[],
    preview: "",
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  }));
  threads[0]!.items = [
    {
      id: "start-" + UUID,
      threadId: THREAD,
      turnId: "turn-" + UUID,
      type: "turn_started",
      createdAt: "2026-10-27T00:00:00Z",
    },
    {
      id: "user-" + UUID,
      threadId: THREAD,
      turnId: "turn-" + UUID,
      type: "user_message",
      content: [{ type: "text", text: literal }],
      createdAt: "2026-10-27T00:00:01Z",
    },
    {
      id: "result-" + UUID,
      threadId: THREAD,
      turnId: "turn-" + UUID,
      type: "tool_result",
      callId: "call",
      toolCallId: "tool-call",
      tool: "fixture",
      output: literal.repeat(20),
      exitCode: 1,
      executionStatus: "failed",
      createdAt: "2026-10-27T00:00:02Z",
    },
    {
      id: "end-" + UUID,
      threadId: THREAD,
      turnId: "turn-" + UUID,
      type: "turn_completed",
      status: "failed",
      createdAt: "2026-10-27T00:00:03Z",
    },
  ];
  let revision = 0;
  const calls: any[] = [];
  const port = {
    projectProjection: { canonicalKeys: async (keys: string[]) => keys },
    request: async (method: string, args: any) => {
      calls.push({ method, args });
      if (method === "thread/list")
        return { data: args.archived ? [] : threads, nextCursor: null };
      if (method === "zen/thread/read" || method === "thread/read")
        return {
          thread: threads.find((thread) => thread.id === args.threadId),
        };
      if (method === "zen/thread/original/read") {
        const { threadId, ...options } = args;
        return readOriginalThreadHistory(
          threads.find((thread) => thread.id === threadId)! as never,
          options,
        );
      }
      if (method === "thread/name/set") {
        threads.find((thread) => thread.id === args.threadId)!.name = args.name;
        return {};
      }
      throw Error("Unexpected native method " + method);
    },
  } as unknown as AppServerRequestPort;
  const service = new ZenXSelfControlCapabilityPackage({
    appServer: port,
    workflows: {
      workflowConfiguration: async () => ({
        revision,
        commands: [],
        titlePrompt: literal,
      }),
      saveWorkflowConfiguration: async (value) => {
        calls.push(value);
        if (value.baseRevision !== revision) throw Error("Workflow conflict");
        revision++;
      },
    },
  });
  return { service, threads, calls, bump: () => revision++ };
}
test("real SelfControl exact same-label refs preserve public literal history and long failed outcomes", async () => {
  const fixture = selfControl(),
    app = bridge(fixture.service.manifest.tools, fixture.service);
  const ambiguous = await app.call("zenx_threads_status", {
    target: "Same label",
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.notEqual(ambiguous.candidates[0].ref, ambiguous.candidates[1].ref);
  assert.doesNotMatch(JSON.stringify(ambiguous), new RegExp(UUID));
  const read = await app.call("zenx_threads_read", {
    ref: ambiguous.candidates[0].ref,
  });
  assert.equal(read.turns[0].status, "failed");
  assert.equal(
    read.turns[0].items.find((item: any) => item.type === "user_message").text,
    literal,
  );
  const failed = read.turns[0].items.find(
    (item: any) => item.type === "tool_result",
  );
  assert.deepEqual(failed.outcome, { exitCode: 1, executionStatus: "failed" });
  assert.equal(failed.preview, undefined);
  assert.equal(failed.item, undefined);
  await app.call("zenx_threads_rename", {
    ref: ambiguous.candidates[1].ref,
    name: "Renamed",
  });
  assert.equal(fixture.threads[1]!.name, "Renamed");
});
test("workflow snapshot remains bound to original CAS under interleaved reads", async () => {
  const fixture = selfControl(),
    app = bridge(fixture.service.manifest.tools, fixture.service);
  const a = await app.call("zenx_self_control_workflows_get", {});
  fixture.bump();
  const b = await app.call("zenx_self_control_workflows_get", {});
  assert.notEqual(a.snapshot, b.snapshot);
  assert.equal(a.revision, undefined);
  assert.equal(a.titlePrompt, literal);
  await assert.rejects(
    app.call("zenx_self_control_workflows_update", {
      snapshot: a.snapshot,
      commands: [],
    }),
    /conflict/,
  );
  assert.equal(app.native.at(-1)!.arguments.baseRevision, 0);
  await app.call("zenx_self_control_workflows_update", {
    snapshot: b.snapshot,
    commands: [],
  });
});
test("selected source and compaction refs read exact local original prefix across restart but never mutate", async () => {
  const fixture = selfControl();
  fixture.threads[0]!.items.push({
    type: "context_compaction",
    id: "compaction",
    coveredThroughItemId: "user-" + UUID,
    includeOriginalReference: true,
  });
  const provenance: ModelReferenceBinding[] = [
    {
      ref: "s1",
      ownerThreadId: "caller",
      namespace: "selected-reference",
      kind: "history",
      value: { threadId: THREAD, throughItemId: "user-" + UUID },
    },
  ];
  const app = bridge(
    fixture.service.manifest.tools,
    fixture.service,
    provenance,
  );
  const read = await app.call("zenx_threads_read", {
    ref: "s1",
    granularity: "items",
  });
  assert.equal(app.native.at(-1)!.arguments.throughItemId, "user-" + UUID);
  assert.ok(!read.items.some((item: any) => item.type === "tool_result"));
  const user = read.items.find((item: any) => item.type === "user_message");
  const restarted = bridge(
    fixture.service.manifest.tools,
    fixture.service,
    app.history,
  );
  const detail = await restarted.call("zenx_threads_read", {
    ref: "s1",
    item: user.ref,
    granularity: "item",
  });
  assert.ok(detail.content.includes(literal));
  await assert.rejects(
    restarted.call("zenx_threads_rename", { ref: "s1", name: "unauthorized" }),
    /unavailable/,
  );
});
test("history root provenance is hidden without altering arbitrary nested referenceBindings or output", () => {
  const item = {
    id: "result",
    threadId: THREAD,
    turnId: "turn",
    type: "tool_result",
    createdAt: "2026-10-27T00:00:00Z",
    callId: "call",
    toolCallId: "tool-call",
    tool: "fixture",
    output: '{"referenceBindings":"literal ' + UUID + '"}',
    exitCode: 0,
    referenceBindings: [
      {
        ref: "r1",
        ownerThreadId: THREAD,
        namespace: "computer",
        kind: "control",
        value: { id: UUID },
      },
    ],
    structuredContent: { referenceBindings: UUID },
  };
  const result = readThreadHistory(
    { id: THREAD, cwd: "/synthetic", items: [item] } as never,
    { granularity: "item", itemId: "result", maxTurns: 1, maxItemsPerTurn: 25 },
  );
  const decoded = JSON.parse(result.content as string);
  assert.equal(decoded.referenceBindings, undefined);
  assert.equal(decoded.output, item.output);
  assert.deepEqual(decoded.structuredContent, item.structuredContent);
});
test("model selection and project Thread refs hide only generated typed envelopes", async () => {
  const { encodeModelKey } = await import("../../../src/protocol/model-key.js");
  const keys = ["provider-" + UUID, "other-" + UUID].map((providerProfileId) =>
    encodeModelKey({ providerProfileId, modelId: "semantic-model" }),
  );
  const definitions = selfControl().service.manifest.tools;
  const app = bridge(definitions, {
    invoke: async (name, invocation) => {
      if (name === "zenx_models_list")
        return {
          source: "native",
          models: keys.map((id) => ({
            id,
            model: id,
            displayName: "Same model",
            isDefault: false,
          })),
        };
      if (name === "zenx_projects_list")
        return {
          source: "native",
          projects: [
            {
              name: "Synthetic",
              workspace: `/tmp/${UUID}`,
              threadIds: [THREAD, OTHER],
            },
          ],
        };
      assert.equal(invocation.arguments.threadId, OTHER);
      assert.equal(invocation.arguments.model, keys[1]);
      return {
        threadId: OTHER,
        model: "semantic-model",
        modelProvider: "other-" + UUID,
      };
    },
  });
  const models = await app.call("zenx_models_list", {});
  assert.notEqual(models.models[0].ref, models.models[1].ref);
  assert.doesNotMatch(JSON.stringify(models), /zen-model-v1/);
  const projects = await app.call("zenx_projects_list", {});
  assert.equal(projects.projects[0].workspace, `/tmp/${UUID}`);
  const configured = await app.call("zenx_threads_configure", {
    ref: projects.projects[0].threads[1].ref,
    model: models.models[1].ref,
  });
  assert.equal(configured.modelProvider, undefined);
});

import {
  createZenXTrustedPlugin,
  type ZenXRoomsTrustedService,
  type Room,
} from "../../../packages/zenx-rooms-plugin/src/runtime.js";
const roomManifest = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/zenx-rooms-plugin/zenx.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function rooms() {
  const room: Room = {
    id: "room-" + UUID,
    name: "Team",
    members: [{ name: "Reviewer", threadId: THREAD }],
    messages: [
      {
        id: "message-" + UUID,
        roomId: "room-" + UUID,
        author: "User",
        text: literal,
        createdAt: 1,
        kind: "human",
        originThreadId: THREAD,
        originTurnId: "turn-" + UUID,
      },
    ],
    createdAt: 1,
  };
  let revision = 0,
    writes = 0;
  const posted: unknown[] = [];
  const service = {
    snapshot: () => ({ rooms: [room] }),
    assistantWorkspace: () => ({
      revision,
      updatedAt: 1,
      matters: [],
      memory: [],
    }),
    updateAssistantWorkspace: async (input: any) => {
      assert.equal(input.roomId, room.id);
      if (input.expectedRevision !== revision)
        throw Error("Workspace conflict; read again");
      writes++;
      revision++;
      return {
        revision,
        updatedAt: 2,
        matters: input.matters,
        memory: input.memory,
      };
    },
    postAgentRoomMessage: async (...input: unknown[]) => {
      posted.push(input);
    },
  } as unknown as ZenXRoomsTrustedService;
  return {
    service: createZenXTrustedPlugin(service),
    bump: () => revision++,
    writes: () => writes,
    posted,
  };
}
test("real Rooms exact message refs preserve literal user UUIDs, replies and immutable CAS", async () => {
  const fixture = rooms(),
    app = bridge(roomManifest.tools, fixture.service);
  const listing = await app.call("zenx_rooms_list", {}),
    room = listing.rooms[0];
  assert.equal(room.name, "Team");
  assert.equal(room.id, undefined);
  assert.equal(listing.readCursorVersion, undefined);
  assert.equal(room.members[0].name, "Reviewer");
  const messages = await app.call("zenx_rooms_messages", { room: room.ref });
  assert.equal(messages.messages[0].text, literal);
  assert.equal(messages.messages[0].originThreadId, undefined);
  await app.call("zenx_rooms_post_message", {
    room: room.ref,
    replyTo: messages.messages[0].ref,
    text: literal,
  });
  assert.deepEqual(fixture.posted, [
    ["room-" + UUID, literal, "message-" + UUID],
  ]);
  const a = await app.call("zenx_rooms_workspace", { room: room.ref });
  fixture.bump();
  const b = await app.call("zenx_rooms_workspace", { room: room.ref });
  assert.notEqual(a.snapshot, b.snapshot);
  await assert.rejects(
    app.call("zenx_rooms_update_workspace", {
      snapshot: a.snapshot,
      matters: [],
      memory: [],
    }),
    /conflict/,
  );
  assert.equal(fixture.writes(), 0);
  await app.call("zenx_rooms_update_workspace", {
    snapshot: b.snapshot,
    matters: [],
    memory: [],
  });
  assert.equal(fixture.writes(), 1);
  assert.ok(
    !app.bundle.tools.some(
      (tool) => tool.name === "zenx_rooms_create_assistant",
    ),
  );
  assert.ok(
    roomManifest.tools.some(
      (tool: ModelTool) => tool.name === "zenx_rooms_create_assistant",
    ),
  );
});
test("postdispatch projection budget preserves known and unclassified outcomes, reserves inspectable durable Trace ref only", async () => {
  for (const inspectable of [false, true]) {
    const registry = new ModelReferenceRegistry();
    const seed = registry.scope("caller"),
      parent = seed.bind("threads", "thread", { id: THREAD, device: "local" });
    const raw = {
      output: JSON.stringify({
        created: true,
        status: "unknown",
        error: literal,
        threads: Array.from({ length: 4097 }, (_, i) => ({
          id: `child-${i}-${UUID}`,
          name: "Synthetic",
        })),
      }),
      exitCode: 0,
      contentType: "application/json",
      structuredContent: { rawRoute: UUID },
    };
    const trace: unknown[] = [];
    let dispatches = 0;
    const result = await invokeModelToolFacade({
      invocation: {
        name: "zenx_subagents_create",
        callId: "budget",
        threadId: "caller",
        cwd: "/synthetic",
        arguments: { parent, mode: "fresh" },
        modelReferences: seed.newBindings,
        ...(inspectable ? { modelTraceInspectionTool: "trace_read" } : {}),
        signal: signal(),
        traceOutput: syntheticTrace({
          recordResult: async (value) => {
            trace.push(value);
            return {
              durability: "durable",
              locator: {
                threadId: "caller",
                recordId: "record-" + UUID,
                callId: "budget",
              },
            };
          },
        }),
      },
      epoch: "epoch",
      references: registry,
      dispatch: async () => {
        dispatches++;
        return raw;
      },
    });
    assert.equal(dispatches, 1);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.output);
    assert.equal(output.projection, "projection_unavailable");
    assert.equal(output.outcome.created, true);
    assert.equal(output.outcome.status, "unknown");
    assert.equal(output.outcome.error, literal);
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.contentType, undefined);
    assert.deepEqual(trace, [raw]);
    const bindings = trustedModelReferenceBindings(result)!;
    assert.equal(bindings.length, inspectable ? 2 : 1);
    if (inspectable) {
      assert.equal(output.trace.tool, "trace_read");
      const restored = new ModelReferenceRegistry().scope("caller", bindings);
      assert.deepEqual(
        restored.resolve(output.trace.ref, "trace", "tool-result"),
        {
          locator: {
            threadId: "caller",
            recordId: "record-" + UUID,
            callId: "budget",
          },
          tool: "trace_read",
        },
      );
    } else assert.equal(output.trace, undefined);
  }
  const result = await invokeModelToolFacade({
    invocation: {
      name: "zenx_threads_create",
      callId: "huge",
      threadId: "caller",
      cwd: "/synthetic",
      arguments: { cwd: "/synthetic" },
      signal: signal(),
    },
    epoch: "epoch",
    references: new ModelReferenceRegistry(),
    dispatch: async () => ({
      output: JSON.stringify({
        threadId: "generated-".repeat(150_000),
        name: "Synthetic",
      }),
      exitCode: 0,
    }),
  });
  assert.equal(
    JSON.parse(result.output).outcome.classification,
    "unclassified",
  );
  assert.ok(result.output.length < 1024);
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import { sidebarTabId } from "../src/thread-sidebar-state.js";
import {
  ZenXTriggersCapabilityPackage,
  type ZenXAutomationControlPort,
} from "../src/main/capabilities/automation-control-package.js";
import { ZenXSubagentsCapabilityPackage } from "../src/main/capabilities/subagents-package.js";
test("sidebar facade exact snapshot preserves other member descriptors and live membership fences", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compact-sidebar-"));
  try {
    const store = new ThreadSidebarStore(directory),
      owner = { kind: "room" as const, id: "room-" + UUID },
      original = {
        kind: "file" as const,
        path: `${UUID}.md`,
        resourceThreadId: OTHER,
      };
    await store.update({
      owner,
      expectedRevision: 0,
      patch: { tabs: [original], selectedTab: sidebarTabId(original) },
    });
    let membership = [
      {
        id: owner.id,
        name: "Team",
        assistant: { threadId: "caller" },
        members: [{ threadId: "caller" }, { threadId: OTHER }],
      },
    ];
    const service = new ZenXSelfControlCapabilityPackage({
      sidebar: store,
      sidebarRooms: () => membership,
      appServer: {
        request: async () => ({ thread: { id: "caller" } }),
      } as never,
    });
    const app = bridge(service.manifest.tools, service);
    const old = await app.call("zenx_self_control_sidebar_read", {});
    assert.equal(old.state.revision, undefined);
    assert.equal(old.state.tabs[0].path, `${UUID}.md`);
    assert.equal(old.state.tabs[0].resourceThreadId, undefined);
    const current = await store.read(owner);
    await store.update({
      owner,
      expectedRevision: current.revision,
      patch: { open: !current.open },
    });
    const fresh = await app.call("zenx_self_control_sidebar_read", {});
    assert.notEqual(old.snapshot, fresh.snapshot);
    const stale = await app.call("zenx_self_control_sidebar_update", {
      snapshot: old.snapshot,
      patch: { open: true },
    });
    assert.equal(stale.applied, false);
    assert.equal(
      app.native.at(-1)!.arguments.expectedRevision,
      current.revision,
    );
    const updated = await app.call("zenx_self_control_sidebar_update", {
      snapshot: fresh.snapshot,
      patch: {
        tabs: [{ ref: fresh.state.tabs[0].ref }],
        selectedTab: fresh.state.tabs[0].ref,
      },
    });
    assert.equal(updated.applied, true);
    assert.deepEqual((await store.read(owner)).tabs, [original]);
    membership = [];
    await assert.rejects(
      app.call("zenx_self_control_sidebar_read", { scope: fresh.scope.ref }),
      /currently belong/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("ambiguous sidebar choices carry semantic names and refs without routing JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compact-sidebar-"));
  try {
    const service = new ZenXSelfControlCapabilityPackage({
      sidebar: new ThreadSidebarStore(directory),
      sidebarRooms: () =>
        ["one", "two"].map((id) => ({
          id: id + UUID,
          name: "Same label",
          assistant: { threadId: "caller" },
          members: [{ threadId: "caller" }],
        })),
      appServer: {
        request: async () => ({ thread: { id: "caller" } }),
      } as never,
    });
    const app = bridge(service.manifest.tools, service),
      choices = await app.call("zenx_self_control_sidebar_read", {});
    assert.equal(choices.status, "ambiguous");
    assert.doesNotMatch(JSON.stringify(choices), new RegExp(UUID));
    assert.notEqual(
      choices.authorizedScopes[1].ref,
      choices.authorizedScopes[2].ref,
    );
    await app.call("zenx_self_control_sidebar_read", {
      scope: choices.authorizedScopes[1].ref,
    });
    assert.equal((app.native.at(-1)!.arguments.scope as any).id, "one" + UUID);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("Trigger facade preserves exact native resume/preview fences and unknown delivery without program rewrite", async () => {
  let revision = 3,
    previewRevision = 7,
    resumed = 0,
    created = 0;
  const triggerId = "trigger-" + UUID,
    historyId = "history-" + UUID;
  const definition = () => ({
    id: triggerId,
    definitionRevision: revision,
    threadId: THREAD,
    kind: "thread",
    label: "Watch",
    prompt: literal,
    createdAt: 1,
    active: false,
    watch: {
      threadId: OTHER,
      event: "turn_completed",
      sourceDevice: "device-" + UUID,
      sourceWorkspace: "Synthetic workspace",
    },
    program: { action: { command: literal, args: [UUID] } },
  });
  const preview = () => ({
    workspace: "/synthetic",
    resolvedWorkspace: "/synthetic",
    model: "opaque-" + UUID,
    modelId: "semantic-model",
    providerProfileId: UUID,
    reasoningEffort: null,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    processEpoch: "epoch-" + UUID,
    revision: previewRevision,
  });
  const calls: any[] = [];
  const port = {
    snapshot: () => ({
      triggers: [definition()],
      rooms: [],
      history: [
        {
          id: historyId,
          triggerId,
          threadId: THREAD,
          kind: "thread",
          reason: "Observed",
          prompt: literal,
          clientUserMessageId: UUID,
          startedAt: 1,
          completedAt: null,
          status: "running",
          delivery: "unknown",
          turnId: null,
          error: "Uncertain: " + literal,
          sourceThreadId: OTHER,
          sourceDevice: "device-" + UUID,
          sourceTurnId: null,
          sourceRoomId: null,
          sourceRoomMessageId: null,
          replyRoomId: null,
          replyAuthor: null,
          programInvocationId: UUID,
          programOutcome: null,
          programOutcomes: [],
        },
      ],
    }),
    resume: async (id: string, expected: number) => {
      assert.equal(id, triggerId);
      if (expected !== revision) throw Error("Definition revision conflict");
      resumed++;
    },
    previewTarget: async () => preview(),
    createTarget: async (workspace: string, expected: any) => {
      assert.equal(workspace, "/synthetic");
      if (JSON.stringify(expected) !== JSON.stringify(preview()))
        throw Error("Target preview changed");
      created++;
      return { threadId: OTHER, effective: preview() };
    },
    update: async (input: any) => {
      calls.push(input);
      return definition();
    },
    result: async (id: string) => {
      assert.equal(id, historyId);
      return {
        sourceDevice: "device-" + UUID,
        threadId: OTHER,
        turnId: "turn-" + UUID,
        status: "failed",
        preview: literal,
      };
    },
  } as unknown as ZenXAutomationControlPort;
  const service = new ZenXTriggersCapabilityPackage(port),
    app = bridge(service.manifest.tools, service);
  const first = await app.call("zenx_triggers_list", {}),
    trigger = first.triggers[0];
  assert.equal(trigger.definitionRevision, undefined);
  assert.equal(trigger.program.action.command, literal);
  assert.equal(first.history[0].delivery, "unknown");
  assert.equal(first.history[0].clientUserMessageId, undefined);
  revision++;
  await assert.rejects(
    app.call("zenx_triggers_resume", { snapshot: trigger.snapshot }),
    /conflict/,
  );
  assert.equal(resumed, 0);
  const fresh = await app.call("zenx_triggers_list", {});
  await app.call("zenx_triggers_resume", {
    snapshot: fresh.triggers[0].snapshot,
  });
  assert.equal(resumed, 1);
  await app.call("zenx_triggers_update", {
    trigger: trigger.ref,
    thread: trigger.thread,
    kind: "thread",
    label: "Watch",
    prompt: literal,
    watchedThread: trigger.watch.thread,
    sourceWorkspace: "Synthetic workspace",
    program: { action: { command: literal } },
  });
  assert.equal(calls[0].watchedThreadId, OTHER);
  assert.equal(calls[0].sourceDevice, "device-" + UUID);
  const target = await app.call("zenx_triggers_preview_target", {
    workspace: "/synthetic",
  });
  assert.equal(target.revision, undefined);
  assert.equal(target.processEpoch, undefined);
  previewRevision++;
  await assert.rejects(
    app.call("zenx_triggers_create_target", { snapshot: target.snapshot }),
    /changed/,
  );
  assert.equal(created, 0);
  const newTarget = await app.call("zenx_triggers_preview_target", {
    workspace: "/synthetic",
  });
  await app.call("zenx_triggers_create_target", {
    snapshot: newTarget.snapshot,
  });
  assert.equal(created, 1);
  const source = await app.call("zenx_triggers_result", {
    history: first.history[0].ref,
  });
  assert.equal(source.status, "failed");
  assert.equal(source.preview, literal);
});

test("real Subagent facade preserves exact native parent/child routes and partial follow-up outcome", async () => {
  const child = {
    id: OTHER,
    parentThreadId: THREAD,
    name: "Same label",
    cwd: "/synthetic",
    providerProfileId: UUID,
    modelId: "semantic-model",
    reasoningEffort: null,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    archived: false,
    items: [],
    turns: [],
  };
  const calls: any[] = [];
  const port = {
    projectProjection: { canonicalKeys: async (keys: string[]) => keys },
    request: async (method: string, args: any) => {
      calls.push({ method, args });
      if (method === "zen/thread/create-child") {
        assert.equal(args.parentThreadId, THREAD);
        return { thread: child };
      }
      if (method === "thread/name/set")
        throw Error("Unknown title outcome " + literal);
      if (method === "zen/thread/read" || method === "thread/read")
        return { thread: child };
      if (method === "thread/list")
        return {
          data: args.archived ? [] : [{ ...child, status: { type: "idle" } }],
          nextCursor: null,
        };
      throw Error("Unexpected " + method);
    },
  } as unknown as AppServerRequestPort;
  const threads = new ZenXSelfControlCapabilityPackage({ appServer: port }),
    service = new ZenXSubagentsCapabilityPackage({
      appServer: port,
      threads,
      listSummaries: async () =>
        [
          {
            threadId: OTHER,
            parentThreadId: THREAD,
            name: "Same label",
            status: "idle",
            currentMetadata: {
              cwd: "/synthetic",
              providerProfileId: UUID,
              modelId: "semantic-model",
            },
          },
        ] as never,
    });
  const registry = new ModelReferenceRegistry(),
    seed = registry.scope("caller"),
    parent = seed.bind("threads", "thread", { id: THREAD, device: "local" });
  const app = bridge(service.manifest.tools, service, seed.newBindings);
  const created = await app.call("zenx_subagents_create", {
    parent,
    mode: "fresh",
    title: "Synthetic",
  });
  assert.equal(created.status, "created");
  assert.equal(created.followUpError, "Unknown title outcome " + literal);
  assert.equal(created.thread.providerProfileId, undefined);
  assert.equal(created.parent, parent);
  const listed = await app.call("zenx_subagents_list", { parent });
  assert.equal(listed.threads[0].ref, created.ref);
  await app.call("zenx_subagents_read", { ref: created.ref });
  assert.equal(app.native.at(-1)!.arguments.threadId, OTHER);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "zen/thread/read" && call.args.threadId === OTHER,
    ),
  );
});

test("degraded Trace capture never invents an inspection ref or loses known backend outcome", async () => {
  const result = await invokeModelToolFacade({
    invocation: {
      name: "zenx_threads_create",
      callId: "degraded",
      threadId: "caller",
      cwd: "/synthetic",
      arguments: { cwd: "/synthetic" },
      signal: signal(),
      modelTraceInspectionTool: "trace_read",
      traceOutput: syntheticTrace({
        recordResult: async () => ({
          durability: "degraded",
          error: "Synthetic storage unavailable",
        }),
      }),
    },
    epoch: "epoch",
    references: new ModelReferenceRegistry(),
    dispatch: async () => ({
      output: JSON.stringify({
        threadId: "generated-".repeat(150_000),
        status: "created",
        followUpError: literal,
      }),
      exitCode: 0,
    }),
  });
  const projected = JSON.parse(result.output);
  assert.equal(projected.projection, "projection_unavailable");
  assert.equal(projected.outcome.status, "created");
  assert.equal(projected.outcome.followUpError, literal);
  assert.equal(projected.trace, undefined);
  assert.equal(trustedModelReferenceBindings(result), undefined);
});

test("native Thread creation runtime settings project their generated model key semantically", async () => {
  const { encodeModelKey } = await import("../../../src/protocol/model-key.js");
  const raw = {
    threadId: THREAD,
    runtime: {
      model: encodeModelKey({
        providerProfileId: UUID,
        modelId: "semantic-model",
      }),
      modelProvider: UUID,
      cwd: `/tmp/${UUID}`,
      reasoningEffort: "high",
    },
  };
  const app = bridge(selfControl().service.manifest.tools, {
    invoke: async () => raw,
  });
  const created = await app.call("zenx_threads_create", { cwd: "/synthetic" });
  assert.equal(created.runtime.model, "semantic-model");
  assert.equal(created.runtime.modelProvider, undefined);
  assert.equal(created.runtime.cwd, `/tmp/${UUID}`);
  assert.ok(
    (
      app.trace.find(
        (entry) => entry.layer === "capability-result-before-model-projection",
      )!.value as ToolExecutionResult
    ).output.includes(raw.runtime.model),
  );
});

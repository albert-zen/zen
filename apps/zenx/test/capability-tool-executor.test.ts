import assert from "node:assert/strict";
import test from "node:test";

import { ZenXHostToolExecutor } from "../src/main/capability-tool-executor.js";
import type { HostEvent } from "../src/main/host-messages.js";

test("exposes capability definitions and resolves main-process execution", async () => {
  const events: HostEvent[] = [];
  const executor = new ZenXHostToolExecutor({
    capabilities: {
      definitions: [
        {
          name: "fixture_inspect",
          description: "Inspect",
          inputSchema: { type: "object" },
        },
      ],
    },
    send: (event) => events.push(event),
  });
  assert.deepEqual(
    executor.definitions.map((definition) => definition.name),
    ["shell", "fixture_inspect"],
  );
  const execution = executor.execute({
    callId: "call-1",
    name: "fixture_inspect",
    arguments: { target: "one" },
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
  const request = events.find((event) => event.type === "capability/invoke");
  assert.equal(request?.type, "capability/invoke");
  if (request?.type !== "capability/invoke") throw new Error("missing request");
  executor.handleResult({
    type: "capability/result",
    invocationId: request.invocationId,
    output: "bounded",
    exitCode: 0,
  });
  assert.deepEqual(await execution, { output: "bounded", exitCode: 0 });
});

test("propagates cancellation to the main-process provider", async () => {
  const events: HostEvent[] = [];
  const executor = new ZenXHostToolExecutor({
    capabilities: {
      definitions: [
        {
          name: "fixture_wait",
          description: "Wait",
          inputSchema: { type: "object" },
        },
      ],
    },
    send: (event) => events.push(event),
  });
  const controller = new AbortController();
  const execution = executor.execute({
    callId: "call-2",
    name: "fixture_wait",
    arguments: {},
    cwd: "/workspace",
    signal: controller.signal,
  });
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(execution, /stop/u);
  assert.equal(events.at(-1)?.type, "capability/cancel");
});

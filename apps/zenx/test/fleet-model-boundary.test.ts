import assert from "node:assert/strict";
import test from "node:test";
import {
  FleetRouter,
  fleetDeviceKey,
  parseFleetConfig,
} from "../src/main/fleet.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../src/main/capabilities/self-control-package.js";
import { ZenXHostToolBundle } from "../src/main/capability-tool-executor.js";
import { trustedModelReferenceBindings } from "../../../src/model-references.js";
import type { ToolInvocation } from "../../../src/tool.js";

const invoke = (
  name: string,
  args: Record<string, unknown>,
): ToolInvocation => ({
  name,
  arguments: args,
  callId: "call",
  threadId: "owner",
  cwd: "/synthetic",
  signal: new AbortController().signal,
});
test("SelfControl remote routes retain the captured key and never follow a recycled configured ID", async () => {
  const original = {
    id: "peer",
    label: "Same label",
    sshHost: "one.example.test",
    command: ["bridge"],
    access: "read",
  };
  let config = parseFleetConfig({ version: 1, devices: [original] });
  const key = fleetDeviceKey(config.devices[0]!);
  const requests: unknown[] = [];
  const fleet = new FleetRouter(
    async () => config,
    async (_device, request) => {
      requests.push(request.arguments);
      return { threads: [] };
    },
  );
  const service = new ZenXSelfControlCapabilityPackage({
    appServer: new MutableAppServerRequestPort(),
    fleet,
  });
  await service.invoke(
    "zenx_threads_list",
    invoke("zenx_threads_list", { device: "peer", deviceKey: key }),
  );
  assert.deepEqual(requests, [{}]);
  config = parseFleetConfig({
    version: 1,
    devices: [{ ...original, sshHost: "replacement.example.test" }],
  });
  await assert.rejects(
    service.invoke(
      "zenx_threads_list",
      invoke("zenx_threads_list", { device: "peer", deviceKey: key }),
    ),
    /changed.*no operation/u,
  );
  assert.equal(requests.length, 1);
});
test("target routing executes the same typed facade before the native Host bridge", async () => {
  const calls: ToolInvocation[] = [];
  const bundle = new ZenXHostToolBundle({
    capabilities: { definitions: [], generationToken: "fixture" },
    send(event) {
      if (event.type !== "capability/invoke") return;
      calls.push({ ...event.invocation, signal: new AbortController().signal });
      bundle.handleResult({
        type: "capability/result",
        invocationId: event.invocationId,
        generationToken: event.generationToken,
        output: JSON.stringify({
          threads: [{ id: "opaque-thread-native", name: "Worker" }],
        }),
        exitCode: 0,
      });
    },
  });
  const result = await bundle.executeTarget(invoke("zenx_threads_list", {}));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(result.output).threads[0].ref, "r1");
  assert.ok(!result.output.includes("opaque-thread-native"));
  assert.equal(
    trustedModelReferenceBindings(result)?.[0]?.value &&
      (trustedModelReferenceBindings(result)![0]!.value as { id: string }).id,
    "opaque-thread-native",
  );
});

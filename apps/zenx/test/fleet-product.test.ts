import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import {
  FleetProductService,
  fleetDeviceKey,
} from "../src/main/fleet-product.js";
import { FleetRouter } from "../src/main/fleet.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import type { FleetRequest, FleetDevice } from "../src/main/fleet.js";
import { ZenXFleetCapabilityPackage } from "../src/main/capabilities/fleet-package.js";
import { ZenXSelfControlCapabilityPackage } from "../src/main/capabilities/self-control-package.js";
import type { ToolInvocation } from "../../../src/tool.js";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";

test("Fleet product operations keep catalog/model/workspace/thread identities on the selected route", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-product-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ peer: string; request: FleetRequest }> = [];
  let missing = false;
  const fleet = new FleetSettingsService({
    directory,
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    manager: () =>
      ({
        fleetControl: async () => ({ enabled: false, clients: [] }),
      }) as unknown as AppServerManager,
    workspaces: async () => [],
    sshTransport: async (peer, request) => {
      calls.push({ peer: peer.id, request });
      if (missing && request.name === "zenx_threads_send")
        return { status: "not_found" };
      if (request.name === "zenx_projects_list")
        return {
          projects: [
            { workspace: `/work/${peer.id}`, name: `${peer.id} project` },
          ],
        };
      if (request.name === "zenx_models_list")
        return {
          models: [
            {
              id: `${peer.id}::model`,
              displayName: `${peer.id} model`,
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
            },
          ],
        };
      if (request.name === "zenx_threads_create")
        return { threadId: "same-id", cwd: `/work/${peer.id}` };
      if (request.name === "zenx_threads_read")
        return {
          threadId: "same-id",
          items: [{ type: "agent_message", text: `${peer.id} reply` }],
        };
      if (request.name === "zenx_threads_status")
        return { threadId: "same-id", status: "idle" };
      if (request.name === "zenx_threads_list")
        return {
          threads: [
            { threadId: "same-id", name: `${peer.id} task`, status: "idle" },
          ],
        };
      return { threadId: "same-id", turnId: "turn" };
    },
  });
  const devices: FleetDevice[] = ["a", "b"].map((id) => ({
    id,
    label: id,
    description: `${id} only`,
    sshHost: id,
    command: ["node", "/bridge.js"],
    access: "control",
  }));
  await fleet.save({ version: 1, devices }, 0);
  const product = new FleetProductService(fleet);
  const selected = await product.catalog("b");
  assert.equal(selected.models[0]!.id, "b::model");
  assert.equal(selected.workspaces[0]!.id, "/work/b");
  const beforeInvalid = calls.length;
  for (const deviceKey of [undefined, ""]) {
    await assert.rejects(
      product.create({
        deviceId: "b",
        deviceKey: deviceKey as string,
        workspace: "/work/b",
        model: "b::model",
      }),
      /machine connection identity/u,
    );
    await assert.rejects(
      product.list({
        deviceId: "b",
        deviceKey: deviceKey as string,
        workspace: "/work/b",
      }),
      /machine connection identity/u,
    );
  }
  assert.equal(
    calls.length,
    beforeInvalid,
    "Missing route identity must fail before any target operation",
  );
  const locator = await product.create({
    deviceId: "b",
    deviceKey: selected.machine.key,
    workspace: "/work/b",
    model: "b::model",
  });
  await product.send({ locator, text: "Run the target task" });
  assert.equal((await product.read(locator)).threadId, "same-id");
  assert.equal((await product.status(locator)).status, "idle");
  assert.ok(calls.every((call) => call.peer === "b"));
  const send = calls.find((call) => call.request.name === "zenx_threads_send")!;
  assert.equal(send.request.arguments.workspace, "/work/b");
  assert.equal(send.request.arguments.threadId, "same-id");
  missing = true;
  await assert.rejects(
    product.send({ locator, text: "Do not silently accept" }),
    /no message was sent/u,
  );
  await fleet.save(
    {
      version: 1,
      devices: [devices[0]!, { ...devices[1]!, sshHost: "changed" }],
    },
    1,
  );
  const before = calls.length;
  await assert.rejects(
    product.read(locator),
    /connection, access or workspace changed/u,
  );
  await assert.rejects(
    product.send({ locator, text: "Must not retarget" }),
    /connection, access or workspace changed/u,
  );
  assert.equal(calls.length, before);
});

test("immutable route fencing is checked at admission and read-only/SSH shell cannot bypass it", async () => {
  const original: FleetDevice = {
    id: "a",
    label: "A",
    sshHost: "a",
    command: ["node", "/bridge"],
    access: "control",
  };
  let current: FleetDevice = { ...original, sshHost: "retargeted" };
  let effects = 0;
  const router = new FleetRouter(
    async () => ({ version: 1, devices: [current] }),
    async () => {
      effects++;
      return {};
    },
  );
  const call: ToolInvocation = {
    callId: "call",
    name: "zenx_threads_send",
    arguments: { target: "same-id", text: "Task" },
    cwd: "/local",
    signal: new AbortController().signal,
  };
  await assert.rejects(
    router.invoke("a", call, fleetDeviceKey(original)),
    /changed before request admission/u,
  );
  current = original;
  await assert.rejects(
    router.invoke("a", {
      ...call,
      name: "zenx_fleet_shell",
      arguments: {
        command: "id",
        targetThreadId: "same-id",
        workspace: "/work",
      },
    }),
    /raw SSH shell fallback is not supported/u,
  );
  current = { ...original, access: "read" };
  await assert.rejects(router.invoke("a", call), /read-only/u);
  assert.equal(effects, 0);
});

test("Fleet is an ordinary explicit model-facing plugin over the existing Zen thread port", async () => {
  const routed: ToolInvocation[] = [];
  const router = new FleetRouter(
    async () => ({
      version: 1,
      devices: [
        {
          id: "remote",
          label: "Remote",
          description: "Build tests",
          sshHost: "remote",
          command: ["node", "/bridge"],
          access: "control",
        },
      ],
    }),
    async (_peer, request) => {
      routed.push({
        ...request,
        cwd: "/target",
        signal: new AbortController().signal,
      });
      return { threadId: "created" };
    },
  );
  const threads = new ZenXSelfControlCapabilityPackage({
    appServer: {} as never,
    fleet: router,
  });
  const fleet = {
    router,
    devices: async () =>
      (await router.devices()).map((device) => ({
        ...device,
        check: { state: "not_checked", live: false },
      })),
  } as unknown as FleetSettingsService;
  const plugin = new ZenXFleetCapabilityPackage({ threads, fleet });
  const invoke = (name: string, args: Record<string, unknown>) =>
    plugin.invoke(name, {
      name,
      arguments: args,
      callId: "call",
      cwd: "/caller",
      signal: new AbortController().signal,
    });
  const listed = (await invoke("zenx_fleet_devices", {})) as {
    devices: Array<{ description?: string }>;
  };
  assert.equal(listed.devices[1]!.description, "Build tests");
  await invoke("zenx_fleet_threads_create", {
    device: "remote",
    workspace: "/remote/work",
    model: "remote::model",
  });
  assert.equal(routed[0]!.name, "zenx_threads_create");
  assert.equal(routed[0]!.arguments.project, "/remote/work");
  assert.equal(routed[0]!.arguments.model, "remote::model");
  assert.equal(fleetManifest.id, "zenx-fleet");
  assert("entry" in fleetManifest.runtime);
  assert.equal(fleetManifest.runtime.entry, "./dist/runtime.js");
  await assert.rejects(
    invoke("zenx_fleet_devices", { command: "not discovery" }),
    /Unexpected Fleet argument/u,
  );
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import type {
  FleetDevice,
  FleetRequest,
  FleetTransport,
  NativeFleetDevice,
} from "../src/main/fleet.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import { subscribeSshFleetThread } from "../src/main/fleet-ssh-watch.js";

type Options = Parameters<
  NonNullable<ZenXTriggerAppServerPort["subscribeRemoteThread"]>
>[3];
const nativePeer: NativeFleetDevice = {
  id: "desktop",
  label: "Desktop",
  transport: "https",
  endpoint: "https://desktop.example",
  hostId: "host-desktop",
  access: "read",
  workspace: "default-workspace",
};
const sshPeer = {
  id: "ssh",
  label: "SSH",
  sshHost: "owner@desktop.example",
  command: ["node", "/app/fleet-bridge.js", "/app/descriptor.json"],
  access: "read" as const,
};
async function fixture(
  devices: FleetDevice[] = [nativePeer],
  sshTransport?: FleetTransport,
  sshWatchLaunch?: Parameters<typeof subscribeSshFleetThread>[5],
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "fleet-trigger-adapter-"),
  );
  const service = new FleetSettingsService({
    directory,
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    },
    manager: () =>
      ({ fleetControl: async () => ({ enabled: false }) }) as never,
    workspaces: async () => [],
    sshTransport,
    sshWatchLaunch,
  });
  await service.save({ version: 1, devices }, 0);
  return {
    service,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
function callbacks() {
  const turns: unknown[] = [];
  const errors: string[] = [];
  let ready = 0;
  const options: Options = {
    includeCurrentTerminal: false,
    onTurn: (value) => {
      turns.push(value);
    },
    onError: (error) => {
      errors.push(error.message);
    },
    onReady: () => {
      ready++;
    },
  };
  return { options, turns, errors, ready: () => ready };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(check(), "Expected Fleet state did not become visible");
}

for (const transport of ["native", "ssh"] as const) {
  test(`${transport} source adapter resolves canonical workspace and reads an exact old Turn outside latest history`, async () => {
    const calls: FleetRequest[] = [];
    const execute = async (_peer: FleetDevice, request: FleetRequest) => {
      calls.push(request);
      if (request.name === "zenx_self_control_threads_wait")
        return {
          threadId: "source-thread",
          turnId: "old-turn",
          status: "failed",
          timedOut: false,
        };
      return {
        threadId: "source-thread",
        cwd:
          transport === "native"
            ? "canonical-workspace"
            : "/canonical/remote/workspace",
        turns: [
          {
            turnId: "latest-turn",
            status: "completed",
            items: [
              {
                type: "agent_message",
                text: "Latest public reply",
                turnId: "latest-turn",
              },
            ],
          },
        ],
        items: [
          {
            type: "agent_message",
            text: "Exact old public reply",
            turnId: "old-turn",
          },
        ],
        truncated: true,
      };
    };
    const setup = await fixture(
      [transport === "native" ? nativePeer : sshPeer],
      execute,
    );
    setup.service.native.invoke = execute;
    try {
      const device = transport === "native" ? "desktop" : "ssh";
      const resolved = await setup.service.resolveRemoteThread(
        device,
        undefined,
        "Exact title",
      );
      assert.deepEqual(resolved, {
        threadId: "source-thread",
        workspace:
          transport === "native"
            ? "canonical-workspace"
            : "/canonical/remote/workspace",
      });
      const read = await setup.service.readRemoteThread(
        device,
        resolved.workspace,
        resolved.threadId,
        "old-turn",
      );
      assert.equal(read.turns[0]?.id, "old-turn");
      assert.equal(read.turns[0]?.status, "failed");
      assert.match(read.turns[0]?.preview ?? "", /Exact old public reply/u);
      assert.doesNotMatch(read.turns[0]?.preview ?? "", /Latest public reply/u);
      assert.deepEqual(
        calls.map((call) => call.name),
        [
          "zenx_threads_read",
          "zenx_threads_read",
          "zenx_self_control_threads_wait",
        ],
      );
      assert.equal(calls[1]?.arguments.turnId, "old-turn");
      assert.equal(calls[1]?.arguments.workspace, resolved.workspace);
      const latest = await setup.service.readRemoteThread(
        device,
        resolved.workspace,
        resolved.threadId,
      );
      assert.equal(latest.turns[0]?.id, "latest-turn");
    } finally {
      await setup.close();
    }
  });
}

test("source adapters reject ambiguity, identity mismatch and a response racing peer retargeting", async () => {
  const setup = await fixture();
  try {
    setup.service.native.invoke = async () => ({
      status: "ambiguous",
      candidates: [],
    });
    await assert.rejects(
      setup.service.resolveRemoteThread("desktop", undefined, "duplicate"),
      /ambiguous/u,
    );
    setup.service.native.invoke = async () => ({
      threadId: "different-thread",
      cwd: "workspace",
      items: [],
    });
    await assert.rejects(
      setup.service.readRemoteThread(
        "desktop",
        "workspace",
        "source-thread",
        "old-turn",
      ),
      /identity changed/u,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    setup.service.native.invoke = async () => {
      entered = true;
      await gate;
      return { threadId: "source-thread", cwd: "workspace", turns: [] };
    };
    const resolving = setup.service.resolveRemoteThread(
      "desktop",
      "workspace",
      "source-thread",
    );
    await until(() => entered);
    await setup.service.save({
      version: 1,
      devices: [{ ...nativePeer, hostId: "replacement-host" }],
    });
    release();
    await assert.rejects(resolving, /retargeted/u);
  } finally {
    await setup.close();
  }
});

test("peer label edits preserve observations; access/workspace/identity changes stop them visibly", async () => {
  const setup = await fixture();
  const registrations: Array<{
    options: Options;
    signal: AbortSignal;
    disposed: number;
  }> = [];
  setup.service.native.subscribeThread = async (
    _peer,
    _workspace,
    _threadId,
    options,
    signal,
  ) => {
    const registration = { options: options as Options, signal, disposed: 0 };
    registrations.push(registration);
    options.onReady?.();
    return () => {
      registration.disposed++;
    };
  };
  try {
    const state = callbacks();
    const stop = await setup.service.subscribeRemoteThread(
      "desktop",
      "canonical-workspace",
      "source-thread",
      state.options,
      new AbortController().signal,
    );
    await setup.service.save({
      version: 1,
      devices: [{ ...nativePeer, label: "Renamed" }],
    });
    assert.equal(registrations[0]?.signal.aborted, false);
    registrations[0]!.options.onTurn({
      threadId: "source-thread",
      turnId: "first",
      status: "completed",
    });
    assert.equal(state.turns.length, 1);
    await setup.service.save({
      version: 1,
      devices: [{ ...nativePeer, access: "control" }],
    });
    assert.equal(registrations[0]?.signal.aborted, true);
    assert.equal(registrations[0]?.disposed, 1);
    assert.match(state.errors[0] ?? "", /access.*changed.*stopped/u);
    registrations[0]!.options.onTurn({
      threadId: "source-thread",
      turnId: "late",
      status: "completed",
    });
    registrations[0]!.options.onReady?.();
    assert.equal(state.turns.length, 1);
    assert.equal(state.ready(), 1);
    stop();
    assert.equal(registrations[0]?.disposed, 1);
    for (const peer of [
      { ...nativePeer, workspace: "new-workspace" },
      { ...nativePeer, endpoint: "https://other.example" },
    ]) {
      const current = callbacks();
      await setup.service.subscribeRemoteThread(
        "desktop",
        "canonical-workspace",
        "source-thread",
        current.options,
        new AbortController().signal,
      );
      await setup.service.save({ version: 1, devices: [peer] });
      assert.equal(registrations.at(-1)?.signal.aborted, true);
      assert.equal(current.errors.length, 1);
    }
  } finally {
    await setup.close();
  }
});

test("pending subscription setup is fenced on remove and its late disposer is called once", async () => {
  const setup = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let registration: { options: Options; signal: AbortSignal } | undefined;
  let disposed = 0;
  setup.service.native.subscribeThread = async (
    _peer,
    _workspace,
    _threadId,
    options,
    signal,
  ) => {
    registration = { options: options as Options, signal };
    await gate;
    return () => {
      disposed++;
    };
  };
  setup.service.native.forget = async () => {};
  try {
    const state = callbacks();
    const subscribing = setup.service.subscribeRemoteThread(
      "desktop",
      "workspace",
      "source-thread",
      state.options,
      new AbortController().signal,
    );
    await until(() => !!registration);
    await setup.service.remove("desktop");
    assert(registration!.signal.aborted);
    registration!.options.onTurn({
      threadId: "source-thread",
      turnId: "late",
      status: "completed",
    });
    assert.equal(state.turns.length, 0);
    assert.match(state.errors[0] ?? "", /authorization was removed.*stopped/u);
    release();
    const stop = await subscribing;
    stop();
    assert.equal(disposed, 1);
    await assert.rejects(
      setup.service.resolveRemoteThread(
        "desktop",
        "workspace",
        "source-thread",
      ),
      /Unknown/u,
    );
  } finally {
    release();
    await setup.close();
  }
});

test("successful re-pair aborts old observers even when the selected Host identity is unchanged", async () => {
  const setup = await fixture();
  let signal: AbortSignal | undefined;
  setup.service.native.subscribeThread = async (
    _peer,
    _workspace,
    _threadId,
    _options,
    input,
  ) => {
    signal = input;
    return () => {};
  };
  setup.service.native.pair = async (peer) => ({
    hostId: peer.hostId,
    deviceId: "11111111-1111-1111-1111-111111111111",
    paired: true,
  });
  try {
    const state = callbacks();
    await setup.service.subscribeRemoteThread(
      "desktop",
      "workspace",
      "source-thread",
      state.options,
      new AbortController().signal,
    );
    await setup.service.pair({
      ...nativePeer,
      code: "FAKE-ONE-TIME-TEST-CODE",
    });
    assert(signal!.aborted);
    assert.match(state.errors[0] ?? "", /pairing changed.*stopped/u);
    assert.equal(state.turns.length, 0);
  } finally {
    await setup.close();
  }
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
  line(value: unknown) {
    this.stdout.write(JSON.stringify(value) + "\n");
  }
  asProcess() {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

test(
  "SSH stream reconnect carries observed active IDs, does not replay old terminals, and ignores old process frames",
  { timeout: 5000 },
  async () => {
    const children: FakeChild[] = [];
    const payloads: any[] = [];
    const state = callbacks();
    const controller = new AbortController();
    const stop = subscribeSshFleetThread(
      sshPeer,
      "/remote/workspace",
      "source-thread",
      state.options,
      controller.signal,
      (payload) => {
        payloads.push(payload);
        const child = new FakeChild();
        children.push(child);
        return child.asProcess();
      },
    );
    try {
      children[0]!.line({ type: "ready", threadId: "source-thread" });
      children[0]!.line({
        type: "active",
        threadId: "source-thread",
        turnId: "observed-turn",
      });
      children[0]!.emit("close", 255, null);
      children[0]!.line({
        type: "turn",
        threadId: "source-thread",
        turnId: "stale-process-turn",
        status: "completed",
      });
      await until(() => state.errors.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(children.length, 2);
      assert.deepEqual(payloads[1].observed, ["observed-turn"]);
      assert.equal(payloads[1].includeCurrentTerminal, false);
      children[1]!.line({ type: "ready", threadId: "source-thread" });
      children[1]!.line({
        type: "turn",
        threadId: "source-thread",
        turnId: "observed-turn",
        status: "completed",
      });
      assert.equal(state.ready(), 2);
      assert.deepEqual(state.turns, [
        {
          threadId: "source-thread",
          turnId: "observed-turn",
          status: "completed",
        },
      ]);
      stop();
      children[1]!.line({
        type: "turn",
        threadId: "source-thread",
        turnId: "after-stop",
        status: "completed",
      });
      assert.equal(state.turns.length, 1);
    } finally {
      stop();
    }
  },
);

for (const bad of [
  { threadId: "wrong", type: "ready" },
  { ok: false },
  {
    threadId: "source-thread",
    type: "turn",
    turnId: "turn",
    status: "inProgress",
  },
]) {
  test(`SSH stream stops on protocol/authentication rejection ${JSON.stringify(bad)}`, async () => {
    const child = new FakeChild();
    const state = callbacks();
    let launches = 0;
    const stop = subscribeSshFleetThread(
      sshPeer,
      "/remote/workspace",
      "source-thread",
      state.options,
      new AbortController().signal,
      () => {
        launches++;
        return child.asProcess();
      },
    );
    try {
      child.line(bad);
      await until(() => state.errors.length === 1);
      child.line({
        type: "turn",
        threadId: "source-thread",
        turnId: "late",
        status: "completed",
      });
      assert(child.killed);
      assert.equal(launches, 1);
      assert.equal(state.turns.length, 0);
    } finally {
      stop();
    }
  });
}

test("SSH stream treats a failed host-key check as terminal, without reconnecting or exposing stderr", async () => {
  const child = new FakeChild();
  const state = callbacks();
  const stop = subscribeSshFleetThread(
    sshPeer,
    undefined,
    "source-thread",
    state.options,
    new AbortController().signal,
    () => child.asProcess(),
  );
  try {
    child.stderr.write("Host key verification failed SECRET-TEST-DETAIL");
    child.emit("close", 255, null);
    await until(() => state.errors.length === 1);
    assert.match(state.errors[0] ?? "", /host-key.*stopped/u);
    assert.doesNotMatch(state.errors[0] ?? "", /SECRET/u);
    assert.equal(state.turns.length, 0);
  } finally {
    stop();
  }
});

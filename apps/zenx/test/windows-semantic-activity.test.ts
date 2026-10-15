import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolInvocation } from "../../../src/tool.js";
import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
} from "../src/main/capabilities/computer-provider.js";
import {
  WinAppCliComputerBackend,
  runBoundedProcess,
  windowsComputerCapabilityManifest,
  type WinAppCliRunOptions,
  type WinAppCliRunResult,
} from "../src/main/capabilities/windows-computer-provider.js";
import {
  ForegroundActivity,
  type ForegroundActivitySnapshot,
} from "../src/main/foreground-activity.js";

const target = { pid: 4242, windowTitle: "Fixture" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function invocation(
  name: string,
  arguments_: Record<string, unknown>,
  overrides: Partial<ToolInvocation> = {},
): ToolInvocation {
  return {
    callId: "call",
    canonicalToolCallId: "canonical-call",
    name,
    arguments: arguments_,
    cwd: "/fixture",
    signal: new AbortController().signal,
    threadId: "owned-thread",
    ...overrides,
  };
}
function fixture(
  options: {
    allowed?: boolean;
    manifest?: typeof windowsComputerCapabilityManifest;
    paint?: (snapshot: ForegroundActivitySnapshot) => Promise<void>;
  } = {},
) {
  const calls: { args: readonly string[]; options: WinAppCliRunOptions }[] = [];
  const owners: ToolInvocation[] = [];
  const snapshots: ForegroundActivitySnapshot[] = [];
  const activity = new ForegroundActivity({
    presenter: {
      update: async (snapshot) => {
        snapshots.push(snapshot);
        await options.paint?.(snapshot);
      },
      close: () => {},
    },
    agentName: () => "Fixture Agent",
    stopOwner: async (owner) => {
      owners.push(owner);
    },
    report: () => {},
  });
  const json = (value: unknown): WinAppCliRunResult => ({
    stdout: JSON.stringify(value),
    stderr: "",
  });
  let intercept:
    | ((
        args: readonly string[],
        options: WinAppCliRunOptions,
      ) => Promise<WinAppCliRunResult | undefined>)
    | undefined;
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    captureRunner: {
      run: async (_executable, args, runOptions) => {
        calls.push({ args, options: runOptions });
        const png = Buffer.alloc(33);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
        png.write("IHDR", 12, "ascii");
        png.writeUInt32BE(1280, 16);
        png.writeUInt32BE(720, 20);
        return json({
          method: "strict-background-printwindow",
          hwnd: "9001",
          processId: 4242,
          windowTitle: "Fixture",
          width: 1280,
          height: 720,
          pngBase64: png.toString("base64"),
        });
      },
    },
    runner: {
      run: async (_executable, args, runOptions) => {
        calls.push({ args, options: runOptions });
        const intercepted = await intercept?.(args, runOptions);
        if (intercepted) return intercepted;
        runOptions.signal?.throwIfAborted();
        switch (args[1]) {
          case "list-windows":
            return json([
              {
                hwnd: "9001",
                processId: 4242,
                processName: "FixtureApp",
                title: "Fixture",
                width: 1280,
                height: 720,
              },
            ]);
          case "inspect":
            return json({
              depth: 8,
              hideDisabled: true,
              hideOffscreen: true,
              windows: [
                {
                  hwnd: "9001",
                  elementCount: 2,
                  elements: [
                    {
                      type: "Button",
                      name: "Save",
                      selector: "button",
                      isEnabled: true,
                      isOffscreen: false,
                      isInvokable: true,
                      x: 10,
                      y: 10,
                      width: 80,
                      height: 30,
                    },
                    {
                      type: "TextBox",
                      name: "Text",
                      selector: "field",
                      isEnabled: true,
                      isOffscreen: false,
                      x: 10,
                      y: 50,
                      width: 80,
                      height: 30,
                    },
                  ],
                },
              ],
            });
          case "invoke":
          case "set-value":
            return json({ hwnd: "9001" });
          case "wait-for":
            return json({ found: true, timedOut: false, waitedMs: 0 });
          default:
            throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
        }
      },
    },
  });
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    options.manifest ?? windowsComputerCapabilityManifest,
    options.allowed ?? true,
    activity,
  );
  return {
    computer,
    activity,
    calls,
    owners,
    snapshots,
    set intercept(value: typeof intercept) {
      intercept = value;
    },
    async inspect() {
      const result = (await computer.invoke(
        "computer_inspect",
        invocation("computer_inspect", { target }),
      )) as ComputerInspection;
      calls.length = 0;
      return result;
    },
  };
}
async function advanceNotice(t: TestContext) {
  await tick();
  t.mock.timers.tick(1000);
  await tick();
}

for (const name of ["computer_press", "computer_set_value"] as const) {
  test(`${name} waits for paint ACK and the full notice before any WinApp launch`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const painted = deferred();
    const state = fixture({
      paint: async (snapshot) => {
        if (snapshot.activities.length) await painted.promise;
      },
    });
    const inspected = await state.inspect();
    const running = state.computer.invoke(
      name,
      invocation(name, {
        target,
        control:
          inspected.controls[name === "computer_press" ? 0 : 1]!.selector,
        value: "text",
      }),
    );
    // Advancing the clock cannot substitute for the renderer's paint ACK.
    await advanceNotice(t);
    assert.equal(state.calls.length, 0);
    assert.equal(state.activity.snapshot.activities.length, 1);
    painted.resolve();
    await tick();
    t.mock.timers.tick(999);
    await tick();
    assert.equal(state.calls.length, 0);
    t.mock.timers.tick(1);
    const result = (await running) as { impact: string };
    assert.equal(result.impact, "foreground_takeover");
    assert.ok(
      state.calls.some(
        ({ args }) =>
          args[1] === (name === "computer_press" ? "invoke" : "set-value"),
      ),
    );
    assert.ok(
      state.calls.every(
        ({ options }) => typeof options.onStopping === "function",
      ),
    );
    assert.equal(state.activity.snapshot.activities.length, 0);
    await state.computer.close();
  });
}

for (const name of ["computer_press", "computer_set_value"] as const) {
  test(`${name} rejects denied consent and invalid arguments before painting or launching`, async () => {
    const state = fixture({ allowed: false });
    const inspected = await state.inspect();
    const arguments_ = {
      target,
      control: inspected.controls[name === "computer_press" ? 0 : 1]!.selector,
      value: "text",
    };
    await assert.rejects(
      state.computer.invoke(name, invocation(name, arguments_)),
      /foreground_required/,
    );
    state.computer.setForegroundControlAllowed(true);
    await assert.rejects(
      state.computer.invoke(
        name,
        invocation(name, {
          ...arguments_,
          ...(name === "computer_press"
            ? { control: {} }
            : { value: "x".repeat(4001) }),
        }),
      ),
      /observationId|4000/,
    );
    assert.equal(state.calls.length, 0);
    assert.equal(state.snapshots.length, 0);
    await state.computer.close();
  });

  test(`${name} paint failure never consumes the selector or dispatches the backend`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let failed = true;
    const state = fixture({
      paint: async (snapshot) => {
        if (failed && snapshot.activities.length)
          throw new Error("paint failed");
      },
    });
    const inspected = await state.inspect();
    const call = invocation(name, {
      target,
      control: inspected.controls[name === "computer_press" ? 0 : 1]!.selector,
      value: "text",
    });
    const rejected = assert.rejects(
      state.computer.invoke(name, call),
      /paint failed/,
    );
    await advanceNotice(t);
    await rejected;
    assert.equal(state.calls.length, 0);
    assert.equal(state.activity.snapshot.activities.length, 0);
    failed = false;
    const retry = state.computer.invoke(name, call);
    await advanceNotice(t);
    await retry;
    assert.ok(
      state.calls.some(
        ({ args }) =>
          args[1] === (name === "computer_press" ? "invoke" : "set-value"),
      ),
    );
    await state.computer.close();
  });

  for (const stage of ["paint", "notice"] as const) {
    for (const cancellation of ["abort", "revoke"] as const) {
      test(`${name} ${cancellation} during ${stage} cannot dispatch or revive after re-enable`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const painted = deferred();
        const controller = new AbortController();
        const state = fixture({
          paint: async (snapshot) => {
            if (stage === "paint" && snapshot.activities.length)
              await painted.promise;
          },
        });
        const inspected = await state.inspect();
        const call = invocation(
          name,
          {
            target,
            control:
              inspected.controls[name === "computer_press" ? 0 : 1]!.selector,
            value: "text",
          },
          { signal: controller.signal },
        );
        const running = state.computer.invoke(name, call);
        const rejected = assert.rejects(
          running,
          cancellation === "abort" ? /external abort/ : /revoked/,
        );
        await tick();
        assert.equal(state.activity.snapshot.activities.length, 1);
        if (cancellation === "abort")
          controller.abort(new Error("external abort"));
        else {
          state.computer.setForegroundControlAllowed(false);
          state.computer.setForegroundControlAllowed(true);
        }
        painted.resolve();
        await advanceNotice(t);
        await rejected;
        assert.equal(state.calls.length, 0);
        assert.equal(state.activity.snapshot.activities.length, 0);
        await state.computer.close();
      });
    }
  }
}

test("read-only discovery, inspection, capture and certified background semantic paths never request activity", async () => {
  const manifest = structuredClone(windowsComputerCapabilityManifest);
  for (const tool of manifest.tools) {
    if (tool.name === "computer_press" || tool.name === "computer_set_value") {
      tool.interactionMode = "background_safe";
      tool.permissions = tool.permissions.filter(
        (permission) => permission !== "computer.foreground.control",
      );
    }
  }
  // The manifest is a test-only future capability declaration, never the stock
  // WinApp manifest. No production background-safety claim is made here.
  const state = fixture({ allowed: false, manifest });
  await state.computer.invoke(
    "computer_list_windows",
    invocation("computer_list_windows", {}),
  );
  for (const name of ["computer_press", "computer_set_value"] as const) {
    const inspected = await state.inspect();
    const result = (await state.computer.invoke(
      name,
      invocation(name, {
        target,
        control:
          inspected.controls[name === "computer_press" ? 0 : 1]!.selector,
        value: "text",
      }),
    )) as { impact?: string };
    assert.equal(result.impact, undefined);
    assert.ok(
      state.calls.every(({ options }) => options.onStopping === undefined),
    );
  }
  const captured = (await state.computer.invoke(
    "computer_screenshot",
    invocation("computer_screenshot", { target }),
  )) as { bytes: number };
  assert.equal(captured.bytes, 33);
  assert.equal(state.snapshots.length, 0);
  await state.computer.close();
});

test("semantic Stop owns one exact call, retains unsettled helpers and ignores stale callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = fixture();
  const nativeCalls: {
    options: WinAppCliRunOptions;
    closed: ReturnType<typeof deferred<void>>;
  }[] = [];
  state.intercept = async (args, options) => {
    if (args[1] !== "invoke") return undefined;
    const closed = deferred();
    nativeCalls.push({ options, closed });
    await closed.promise;
    options.signal?.throwIfAborted();
    return undefined;
  };
  const firstInspection = await state.inspect();
  const first = state.computer.invoke(
    "computer_press",
    invocation(
      "computer_press",
      { target, control: firstInspection.controls[0]!.selector },
      { canonicalToolCallId: "first-canonical" },
    ),
  );
  const rejected = assert.rejects(first, /stopped by user/);
  await advanceNotice(t);
  const firstId = state.activity.snapshot.activities[0]!.id;
  const secondInspection = await state.inspect();
  const second = state.computer.invoke(
    "computer_press",
    invocation(
      "computer_press",
      { target, control: secondInspection.controls[0]!.selector },
      { callId: "second", canonicalToolCallId: "second-canonical" },
    ),
  );
  await advanceNotice(t);
  state.activity.stop([firstId, "forged"]);
  state.activity.stop([firstId]);
  assert.equal(nativeCalls.length, 2);
  assert.equal(nativeCalls[0]!.options.signal!.aborted, true);
  assert.equal(nativeCalls[1]!.options.signal!.aborted, false);
  assert.deepEqual(
    state.owners.map((owner) => [owner.threadId, owner.canonicalToolCallId]),
    [["owned-thread", "first-canonical"]],
  );
  assert.deepEqual(
    state.activity.snapshot.activities.map((entry) => entry.stopping),
    [true, false],
  );
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(
    state.activity.snapshot.activities.length,
    2,
    "unknown native settlement cannot expire activity",
  );
  nativeCalls[0]!.closed.resolve();
  await rejected;
  assert.equal(state.activity.snapshot.activities.length, 1);
  nativeCalls[0]!.options.onStopping?.();
  state.activity.stop([firstId]);
  assert.equal(state.activity.snapshot.activities[0]!.stopping, false);
  assert.equal(nativeCalls[1]!.options.signal!.aborted, false);
  nativeCalls[1]!.closed.resolve();
  await second;
  assert.equal(state.activity.snapshot.activities.length, 0);
  await state.computer.close();
});

for (const phase of [
  "list-windows",
  "inspect",
  "set-value",
  "wait-for",
  "refresh",
] as const) {
  test(`semantic ${phase} timeout uses the same operation's stopping callback until close`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const state = fixture();
    const inspected = await state.inspect();
    const closed = deferred();
    let windowCalls = 0;
    state.intercept = async (args, options) => {
      if (args[1] === "list-windows") windowCalls++;
      const reached =
        phase === "refresh"
          ? args[1] === "list-windows" && windowCalls === 2
          : args[1] === phase;
      if (!reached) return undefined;
      assert.equal(typeof options.onStopping, "function");
      options.onStopping!();
      await closed.promise;
      throw new Error("native timed out");
    };
    const running = state.computer.invoke(
      "computer_set_value",
      invocation("computer_set_value", {
        target,
        control: inspected.controls[1]!.selector,
        value: "text",
      }),
    );
    const rejected = assert.rejects(running, /native timed out/);
    await advanceNotice(t);
    assert.equal(state.activity.snapshot.activities[0]?.stopping, true);
    assert.equal(
      state.owners.length,
      0,
      "provider failure does not interrupt an unrelated Turn",
    );
    closed.resolve();
    await rejected;
    assert.equal(state.activity.snapshot.activities.length, 0);
    await state.computer.close();
  });
}

for (const killResult of ["false", "throws", "error event"] as const) {
  test(`real semantic helper timeout remains stopping until actual close when kill ${killResult}`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-semantic-activity-"),
    );
    const ready = path.join(directory, "ready");
    const stopping = deferred();
    const state = fixture();
    const inspected = await state.inspect();
    const originalKill = ChildProcess.prototype.kill;
    let ownedPid: number | undefined;
    let child: ChildProcess | undefined;
    let nativeClosed = false;
    let released = false;
    let settled = false;
    let killRequests = 0;
    let stoppingCalls = 0;
    // Only intercept the fixture child after its explicit readiness marker.
    ChildProcess.prototype.kill = function (...args) {
      if (this.pid !== ownedPid) return originalKill.apply(this, args);
      child = this;
      this.once("close", () => {
        nativeClosed = true;
      });
      killRequests++;
      if (killResult === "throws") throw new Error("EPERM fixture");
      if (killResult === "error event")
        this.emit("error", new Error("EPERM fixture"));
      return false;
    };
    state.intercept = async (args, options) => {
      if (args[1] !== "invoke") return undefined;
      const operation = runBoundedProcess(
        process.execPath,
        [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(0), 5000);`,
        ],
        {
          ...options,
          timeoutMs: 1000,
          bindBeforeSpawn: async () => async () => {
            released = true;
          },
          onStopping: () => {
            stoppingCalls++;
            options.onStopping?.();
            stopping.resolve();
          },
        },
      );
      // Attach immediately so assertions cannot leave an unhandled rejection.
      void operation.catch(() => {});
      const deadline = Date.now() + 900;
      while (ownedPid === undefined && Date.now() < deadline) {
        try {
          ownedPid = Number(await readFile(ready, "utf8"));
        } catch {
          await sleep(5);
        }
      }
      assert.ok(ownedPid, "fixture process reached readiness before timeout");
      return await operation;
    };
    const running = state.computer.invoke(
      "computer_press",
      invocation("computer_press", {
        target,
        control: inspected.controls[0]!.selector,
      }),
    );
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(running, /timed out after 1000ms/);
    try {
      await Promise.race([
        stopping.promise,
        sleep(3000, undefined, { ref: false }).then(() => {
          throw new Error("native termination did not report onStopping");
        }),
      ]);
      await sleep(25);
      assert.equal(stoppingCalls, 1);
      assert.equal(killRequests, 1);
      assert.equal(settled, false);
      assert.equal(released, false);
      assert.equal(state.activity.snapshot.activities[0]?.stopping, true);
      assert.ok(child);
      process.kill(ownedPid!, 0);
      originalKill.call(child, "SIGKILL");
      await rejected;
      assert.equal(nativeClosed, true);
      assert.equal(released, true);
      assert.equal(state.activity.snapshot.activities.length, 0);
    } finally {
      ChildProcess.prototype.kill = originalKill;
      if (child && !nativeClosed) originalKill.call(child, "SIGKILL");
      await rejected;
      await state.computer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("semantic Stop waits for real process close and asynchronous launch-binding release", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-semantic-stop-"),
  );
  const ready = path.join(directory, "ready");
  const releasing = deferred();
  const released = deferred();
  const state = fixture();
  const inspected = await state.inspect();
  let pid: number | undefined;
  let closedBeforeRelease = false;
  state.intercept = async (args, options) => {
    if (args[1] !== "invoke") return undefined;
    return await runBoundedProcess(
      process.execPath,
      [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(0), 5000);`,
      ],
      {
        ...options,
        bindBeforeSpawn: async () => async () => {
          try {
            process.kill(pid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              closedBeforeRelease = true;
            else throw error;
          }
          releasing.resolve();
          await released.promise;
        },
      },
    );
  };
  const running = state.computer.invoke(
    "computer_press",
    invocation("computer_press", {
      target,
      control: inspected.controls[0]!.selector,
    }),
  );
  const rejected = assert.rejects(running, /stopped by user/);
  try {
    const deadline = Date.now() + 4000;
    while (pid === undefined && Date.now() < deadline) {
      try {
        pid = Number(await readFile(ready, "utf8"));
      } catch {
        await sleep(5);
      }
    }
    assert.ok(pid);
    state.activity.stop(
      state.activity.snapshot.activities.map((entry) => entry.id),
    );
    await releasing.promise;
    assert.equal(closedBeforeRelease, true);
    assert.equal(state.activity.snapshot.activities[0]?.stopping, true);
    assert.equal(state.owners[0]?.canonicalToolCallId, "canonical-call");
    released.resolve();
    await rejected;
    assert.equal(state.activity.snapshot.activities.length, 0);
  } finally {
    state.activity.stop(
      state.activity.snapshot.activities.map((entry) => entry.id),
    );
    released.resolve();
    await rejected;
    await state.computer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

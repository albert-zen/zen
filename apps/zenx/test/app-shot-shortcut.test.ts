import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  MAC_APP_SHOT_MODIFIER_PAIR_JXA,
  startAppShotModifierPair,
  type AppShotModifierPairDependencies,
  type AppShotModifierPairOptions,
} from "../src/main/app-shot-shortcut.js";
import {
  createWindowsShiftPairEdgeDetector,
  windowsShiftPairPressed,
} from "../src/main/app-shot-shortcut-worker.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  readonly signals: NodeJS.Signals[] = [];
  connected = true;
  closeOnSignal = true;
  closed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.emit("signal", signal);
    if (this.closeOnSignal) queueMicrotask(() => this.finish(null, signal));
    return true;
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function harness(
  options: Partial<AppShotModifierPairOptions> = {},
  dependencies: AppShotModifierPairDependencies = {},
) {
  const child = new FakeChild();
  const failures: Error[] = [];
  let triggers = 0;
  const launches: Array<{ file: string; args: readonly string[] }> = [];
  return {
    child,
    failures,
    launches,
    get triggers() {
      return triggers;
    },
    start: () =>
      startAppShotModifierPair(
        {
          platform: "darwin",
          onTrigger: () => {
            triggers++;
          },
          onFailure: (error) => failures.push(error),
          ...options,
        },
        {
          spawn: (file, args) => {
            launches.push({ file, args });
            return child as unknown as ChildProcess;
          },
          fork: (file, args) => {
            launches.push({ file, args });
            return child as unknown as ChildProcess;
          },
          ...dependencies,
        },
      ),
  };
}

function runNativeLogic(flags: number[], parentMatches = true) {
  const lines: string[] = [];
  const delays: number[] = [];
  let reads = 0;
  let policy: number | undefined;
  runInNewContext(
    MAC_APP_SHOT_MODIFIER_PAIR_JXA + "; run(argv);",
    {
      argv: ["42", String(flags.length)],
      ObjC: { import: () => {} },
      $: {
        NSApplication: {
          sharedApplication: {
            setActivationPolicy: (next: number) => {
              policy = next;
            },
          },
        },
        NSApplicationActivationPolicyProhibited: 2,
        getppid: () => (parentMatches ? 42 : 1),
        CGEventSourceFlagsState: (source: number) => {
          assert.equal(source, 0);
          const value = flags[reads++];
          assert.notEqual(value, undefined);
          return value;
        },
      },
      console: { log: (line: string) => lines.push(line) },
      delay: (seconds: number) => delays.push(seconds),
    },
    { timeout: 1000 },
  );
  return { lines, delays, reads, policy };
}

describe("App Shot physical Shift-pair native logic", () => {
  it("does not confuse either Shift, aggregate Shift, or sequential taps with a pair", () => {
    const result = runNativeLogic([0, 0x2, 0, 0x4, 0, 0x20000, 0x2, 0]);
    assert.deepEqual(result.lines, ["ready", "smoke:8"]);
    assert.equal(result.reads, 8);
    assert.equal(result.policy, 2);
    assert.ok(result.delays.every((seconds) => seconds === 0.05));
  });

  it("fires one rising edge per overlap and rearms when either key is released", () => {
    const result = runNativeLogic([0x2, 0x6, 0x6, 0x4, 0x6, 0, 0x6]);
    assert.deepEqual(result.lines, [
      "ready",
      "trigger",
      "trigger",
      "trigger",
      "smoke:7",
    ]);
  });

  it("matches T3 by triggering once when both Shift keys are already held", () => {
    assert.deepEqual(runNativeLogic([0x6, 0x6, 0x6]).lines, [
      "ready",
      "trigger",
      "smoke:3",
    ]);
    assert.deepEqual(runNativeLogic([0x20006]).lines, [
      "ready",
      "trigger",
      "smoke:1",
    ]);
  });

  it("stops before sampling when ownership of the native child is lost", () => {
    const result = runNativeLogic([0x6], false);
    assert.equal(result.reads, 0);
    assert.deepEqual(result.lines, ["ready", "smoke:0"]);
  });

  it("contains only modifier observation, with no key event hook or input API", () => {
    assert.match(
      MAC_APP_SHOT_MODIFIER_PAIR_JXA,
      /CGEventSourceFlagsState\(0\)/,
    );
    assert.doesNotMatch(
      MAC_APP_SHOT_MODIFIER_PAIR_JXA,
      /CGEventTap|CGEventPost|AXIsProcessTrusted|keyCode|keyDown|keyUp/,
    );
  });
});

describe("App Shot modifier monitor lifecycle", () => {
  it("spawns one fixed system command and accepts fragmented ready/trigger lines", async () => {
    const h = harness();
    const pending = h.start();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]?.file, "/usr/bin/osascript");
    assert.deepEqual(h.launches[0]?.args, [
      "-l",
      "JavaScript",
      "-e",
      MAC_APP_SHOT_MODIFIER_PAIR_JXA,
      String(process.pid),
      "0",
    ]);
    h.child.stderr.write("rea");
    h.child.stderr.write("dy\r\ntri");
    const monitor = await pending;
    h.child.stderr.write("gger\ntrigger\n");
    assert.equal(h.triggers, 2);
    await monitor.stop();
    assert.equal(h.child.closed, true);
    assert.deepEqual(h.failures, []);
  });

  it("handles a held-at-startup trigger in the same chunk as ready", async () => {
    const h = harness();
    const pending = h.start();
    h.child.stderr.write("ready\ntrigger\n");
    const monitor = await pending;
    assert.equal(h.triggers, 1);
    await monitor.stop();
  });

  it("rejects trigger-before-ready, duplicate ready and invalid protocol", async () => {
    for (const output of [
      "trigger\n",
      "ready\nready\n",
      "untrusted diagnostic\n",
    ]) {
      const h = harness();
      const pending = h.start();
      if (output.startsWith("ready")) {
        h.child.stderr.write(output);
        const monitor = await pending;
        await monitor.stop();
        assert.equal(h.failures.length, 1);
        assert.match(h.failures[0]!.message, /invalid output/);
      } else {
        const rejected = assert.rejects(pending, /invalid output/);
        h.child.stderr.write(output);
        await rejected;
        assert.deepEqual(h.failures, []);
      }
      assert.equal(h.child.closed, true);
      assert.equal(h.triggers, 0);
    }
  });

  it("bounds unfinished lines, individual chunks and unexpected stdout", async () => {
    for (const [stream, output] of [
      ["stderr", "x".repeat(129)],
      ["stderr", "x".repeat(4097)],
      ["stdout", "untrusted output"],
    ] as const) {
      const h = harness();
      const pending = h.start();
      const rejected = assert.rejects(
        pending,
        /output exceeded its limit|unexpected output/,
      );
      h.child[stream].write(output);
      await rejected;
      assert.equal(h.child.closed, true);
      assert.equal(h.launches.length, 1);
    }
  });

  it("times out readiness and settles the owned process before rejecting", async () => {
    const h = harness({}, { readyTimeoutMs: 10 });
    await assert.rejects(h.start(), /ready timed out/);
    assert.equal(h.child.closed, true);
    assert.deepEqual(h.child.signals, ["SIGTERM"]);
    assert.equal(h.launches.length, 1);
  });

  it("rejects spawn errors and exits before readiness", async () => {
    for (const failure of ["error", "exit"] as const) {
      const h = harness();
      const pending = h.start();
      const rejected = assert.rejects(pending, /helper failed|helper exited/);
      if (failure === "error") h.child.emit("error", new Error("ENOENT"));
      else h.child.finish(1);
      await rejected;
      assert.equal(h.child.closed, true);
      assert.deepEqual(h.failures, []);
    }
  });

  it("disables immediately on a child error and reports once without restart", async () => {
    const h = harness();
    const pending = h.start();
    h.child.stderr.write("ready\n");
    const monitor = await pending;
    h.child.emit("error", new Error("native failure"));
    h.child.stderr.write("trigger\n");
    h.child.emit("error", new Error("second failure"));
    assert.equal(h.failures.length, 1);
    assert.equal(h.triggers, 0);
    await monitor.stop();
    assert.equal(h.launches.length, 1);
  });

  it("disables on exit before stdio closes and ignores any late trigger", async () => {
    const h = harness();
    h.child.closeOnSignal = false;
    const pending = h.start();
    h.child.stderr.write("ready\n");
    const monitor = await pending;
    h.child.emit("exit", 1, null);
    h.child.stderr.write("trigger\n");
    assert.equal(h.failures.length, 1);
    assert.equal(h.triggers, 0);
    const stopping = monitor.stop();
    h.child.finish(1);
    await stopping;
  });

  it("makes stop idempotent, fences callbacks synchronously and waits for close", async () => {
    const h = harness({}, { stopGraceMs: 10 });
    h.child.closeOnSignal = false;
    const pending = h.start();
    h.child.stderr.write("ready\n");
    const monitor = await pending;
    const first = monitor.stop();
    const second = monitor.stop();
    assert.equal(first, second);
    h.child.stderr.write("trigger\n");
    assert.equal(h.triggers, 0);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    const escalated = once(h.child, "signal");
    assert.deepEqual(await escalated, ["SIGKILL"]);
    assert.deepEqual(h.child.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(settled, false);
    h.child.finish(null, "SIGKILL");
    await first;
    assert.deepEqual(h.failures, []);
  });

  it("cancels a pending start and silently stops an enabled monitor on abort", async () => {
    for (const ready of [false, true]) {
      const controller = new AbortController();
      const h = harness({ signal: controller.signal });
      const pending = h.start();
      if (ready) {
        h.child.stderr.write("ready\n");
        const monitor = await pending;
        controller.abort();
        h.child.stderr.write("trigger\n");
        await monitor.stop();
      } else {
        const rejected = assert.rejects(pending, /cancelled/);
        controller.abort();
        await rejected;
      }
      assert.equal(h.child.closed, true);
      assert.equal(h.triggers, 0);
      assert.deepEqual(h.failures, []);
    }
  });

  it("does not spawn for pre-aborted, unsupported or invalid timeout requests", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const [options, dependencies, pattern] of [
      [{ signal: controller.signal }, {}, /cancelled/],
      [{ platform: "win32" }, {}, /worker path/],
      [{ platform: "win32", workerPath: "relative.js" }, {}, /worker path/],
      [{ platform: "linux" }, {}, /unavailable/],
      [{}, { readyTimeoutMs: Infinity }, /timeout/],
      [{}, { stopGraceMs: 0 }, /timeout/],
    ] as const) {
      const h = harness(options, dependencies);
      await assert.rejects(h.start(), pattern);
      assert.equal(h.launches.length, 0);
    }
  });

  it("cleans parent-exit and pipe listeners after repeated start/stop", async () => {
    const baseline = process.listenerCount("exit");
    for (let i = 0; i < 3; i++) {
      const h = harness();
      const pending = h.start();
      h.child.stderr.write("ready\n");
      const monitor = await pending;
      assert.equal(process.listenerCount("exit"), baseline + 1);
      await monitor.stop();
      assert.equal(h.child.stdout.listenerCount("data"), 0);
      assert.equal(h.child.stderr.listenerCount("data"), 0);
      assert.equal(h.child.listenerCount("error"), 0);
      assert.equal(process.listenerCount("exit"), baseline);
    }
    await sleep(1);
    assert.equal(process.listenerCount("exit"), baseline);
  });

  it("settles Windows exit and pipe closure when aggregate close is omitted", async () => {
    const h = harness({
      platform: "win32",
      workerPath: "C:\\zenx\\out\\main\\app-shot-shortcut-worker.js",
    });
    h.child.closeOnSignal = false;
    const pending = h.start();
    h.child.emit("message", "ready");
    const monitor = await pending;
    h.child.connected = false;
    h.child.emit("disconnect");
    let settled = false;
    const stopping = monitor.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, "disconnect alone is not proof of exit");
    h.child.emit("exit", 0, null);
    await Promise.resolve();
    assert.equal(settled, false, "exit alone does not close owned pipes");
    h.child.stdout.destroy();
    h.child.stderr.destroy();
    await stopping;
    assert.equal(settled, true);
    assert.equal(h.failures.length, 1);
    assert.equal(h.child.listenerCount("message"), 0);
    assert.equal(h.child.listenerCount("close"), 0);
  });

  it("rejects a shutdown deadline instead of claiming an unconfirmed exit", async () => {
    const baseline = process.listenerCount("exit");
    const h = harness({}, { stopGraceMs: 1, stopTimeoutMs: 10 });
    h.child.closeOnSignal = false;
    const pending = h.start();
    h.child.stderr.write("ready\n");
    const monitor = await pending;
    await assert.rejects(monitor.stop(), /child exit was not confirmed/);
    assert.ok(h.child.signals.includes("SIGKILL"));
    h.child.stderr.write("trigger\n");
    assert.equal(h.triggers, 0);
    assert.equal(process.listenerCount("exit"), baseline + 1);
    // Ownership survives the rejected wait until the real close is observed.
    h.child.finish();
    assert.equal(process.listenerCount("exit"), baseline);
  });

  it("rejects startup even if readiness and process shutdown both time out", async () => {
    const h = harness(
      {},
      { readyTimeoutMs: 1, stopGraceMs: 1, stopTimeoutMs: 10 },
    );
    h.child.closeOnSignal = false;
    await assert.rejects(
      h.start(),
      /ready timed out; .*child exit was not confirmed/,
    );
    h.child.finish();
  });

  it("still stops if trigger and failure callbacks throw", async () => {
    const h = harness({
      onTrigger: () => {
        throw new Error("capture callback failure");
      },
      onFailure: () => {
        throw new Error("UI callback failure");
      },
    });
    const pending = h.start();
    h.child.stderr.write("ready\n");
    const monitor = await pending;
    assert.doesNotThrow(() => h.child.stderr.write("trigger\n"));
    await monitor.stop();
    assert.equal(h.child.closed, true);
  });
});

describe("App Shot Windows physical modifier worker", () => {
  const workerPath = "C:\\zenx\\out\\main\\app-shot-shortcut-worker.js";

  it("reads only VK_LSHIFT/VK_RSHIFT high bits, including signed SHORT values", () => {
    const keys: number[] = [];
    assert.equal(
      windowsShiftPairPressed((key) => {
        keys.push(key);
        return -32768;
      }),
      true,
    );
    assert.deepEqual(keys, [0xa0, 0xa1]);
    assert.equal(
      windowsShiftPairPressed(() => 0x0001),
      false,
    );
    assert.equal(
      windowsShiftPairPressed(() => 0x8000),
      true,
    );
    assert.equal(
      windowsShiftPairPressed((key) => (key === 0xa0 ? 0x8000 : 0)),
      false,
    );
    assert.equal(
      windowsShiftPairPressed((key) => (key === 0xa1 ? 0x8000 : 0)),
      false,
    );
  });

  it("matches T3 rising edges, including the initial held pair", () => {
    const samples = [true, true, false, true, false, false, true];
    let index = 0;
    const edge = createWindowsShiftPairEdgeDetector(() => samples[index++]!);
    assert.deepEqual(
      samples.map(() => edge()),
      [true, false, false, true, false, false, true],
    );
  });

  it("forks only the explicitly supplied worker path and uses ready/trigger IPC", async () => {
    const h = harness({ platform: "win32", workerPath });
    const pending = h.start();
    assert.deepEqual(h.launches, [
      { file: workerPath, args: ["app-shot-modifier-monitor"] },
    ]);
    h.child.emit("message", "ready");
    const monitor = await pending;
    h.child.emit("message", "trigger");
    assert.equal(h.triggers, 1);
    await monitor.stop();
    assert.equal(h.child.closed, true);
    assert.equal(h.child.listenerCount("message"), 0);
    assert.equal(h.child.listenerCount("disconnect"), 0);
  });

  it("rejects unexpected, oversized and object IPC without retaining its contents", async () => {
    for (const message of [
      "trigger",
      "x".repeat(10_000),
      { type: "trigger", text: "untrusted diagnostic" },
    ]) {
      const h = harness({ platform: "win32", workerPath });
      const pending = h.start();
      const rejected = assert.rejects(pending, /invalid output/);
      h.child.emit("message", message);
      await rejected;
      assert.equal(h.child.closed, true);
      assert.equal(h.triggers, 0);
    }
  });

  it("rejects unexpected Windows stderr rather than interpreting it as commands", async () => {
    const h = harness({ platform: "win32", workerPath });
    const pending = h.start();
    const rejected = assert.rejects(pending, /helper failed/);
    h.child.stderr.write("ready\ntrigger\n");
    await rejected;
    assert.equal(h.triggers, 0);
  });

  it("fences and stops immediately when the worker IPC channel disconnects", async () => {
    for (const ready of [false, true]) {
      const h = harness({ platform: "win32", workerPath });
      const pending = h.start();
      if (ready) {
        h.child.emit("message", "ready");
        const monitor = await pending;
        h.child.connected = false;
        h.child.emit("disconnect");
        h.child.emit("message", "trigger");
        assert.equal(h.failures.length, 1);
        assert.match(h.failures[0]!.message, /disconnected/);
        await monitor.stop();
      } else {
        const rejected = assert.rejects(pending, /disconnected/);
        h.child.connected = false;
        h.child.emit("disconnect");
        await rejected;
      }
      assert.equal(h.child.closed, true);
      assert.equal(h.triggers, 0);
      assert.equal(h.launches.length, 1);
    }
  });
});

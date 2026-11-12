import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { spawn } from "node:child_process";
import { SystemExternalProviderProcessRunner } from "../src/main/capabilities/external-provider.js";
import { PeekabooComputerBackend } from "../src/main/capabilities/peekaboo-computer-provider.js";
import { PlaywrightCliBrowserBackend } from "../src/main/capabilities/playwright-browser-provider.js";
import {
  selectComputerProvider,
  probePlaywrightCli,
} from "../src/main/capabilities/provider-catalog.js";
import {
  ZenXHostLifecycle,
  ZenXBootstrapFence,
} from "../src/main/host-lifecycle.js";
import { LifecycleWaitUnconfirmedError } from "../src/main/lifecycle-wait.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let kills = 0;
  const children: ReturnType<typeof child>[] = [];
  function child() {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {
        kills++;
        return false;
      },
    });
  }
  const runner = new SystemExternalProviderProcessRunner((() => {
    const value = child();
    children.push(value);
    return value;
  }) as unknown as typeof spawn);
  let quit = 0;
  let stops = 0;
  const reports: unknown[] = [];
  return {
    runner,
    children,
    reports,
    counts: () => ({ kills, spawns: children.length, quit, stops }),
    lifecycle(
      stop: () => Promise<void>,
      cancelBootstrap?: () => Promise<void>,
    ) {
      return new ZenXHostLifecycle({
        platform: "linux",
        windowCount: () => 0,
        createWindow() {},
        cancelBootstrap,
        shutdownWaitMs: 20,
        stopHost: () => {
          stops++;
          return stop();
        },
        finishQuit() {
          quit++;
        },
        reportStopFailure(error) {
          reports.push(error);
        },
      });
    },
  };
}

test("Peekaboo cleanup has bounded Quit failure without clearing the live operation or auto-quitting", async () => {
  const f = fixture();
  const backend = new PeekabooComputerBackend({
    executable: "/synthetic/peekaboo",
    runner: {
      run(executable, args, options) {
        if (args[0] === "see")
          return Promise.resolve({
            stdout: JSON.stringify({
              success: true,
              data: { snapshot_id: "synthetic", ui_elements: [] },
            }),
            stderr: "",
          });
        return f.runner.run(executable, args, options);
      },
    },
  });
  await backend.inspect({ pid: 42, windowTitle: "Synthetic" });
  const host = f.lifecycle(() => backend.close());
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().quit, 0);
  assert.equal(f.reports.length, 1);
  assert.ok(f.reports[0] instanceof LifecycleWaitUnconfirmedError);
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(
    f.reports.length,
    1,
    "re-observing a pending shutdown must not spam dialogs",
  );
  assert.equal(f.counts().stops, 1);
  assert.equal(f.counts().spawns, 1);
  // Actual production clean timeout, not a shortened external runner deadline.
  await sleep(5050);
  assert.equal(f.counts().kills, 1);
  assert.equal(f.counts().quit, 0);
  f.children[0]!.emit("close", null, "SIGKILL");
  await tick();
  assert.equal(f.counts().quit, 0, "late close is not another user Quit");
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().quit, 1);
  assert.equal(f.counts().stops, 1);
});

test("Browser failed kill retains its lease and bounded Quit only re-observes the same cleanup", async () => {
  const f = fixture();
  let releases = 0;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/synthetic/playwright",
    cwd: "/tmp",
    runner: f.runner,
    bindBeforeSpawn: async () => async () => {
      releases++;
    },
  });
  const controller = new AbortController();
  const pending = backend.open(
    "synthetic",
    "https://invalid.example/",
    controller.signal,
  );
  const rejected = assert.rejects(pending, /synthetic abort/);
  await tick();
  controller.abort(new Error("synthetic abort"));
  const host = f.lifecycle(() => backend.close());
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.deepEqual(f.counts(), { kills: 1, spawns: 1, quit: 0, stops: 1 });
  assert.equal(releases, 0);
  assert.equal(f.reports.length, 1);
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().stops, 1);
  assert.equal(f.counts().spawns, 1);
  assert.equal(f.reports.length, 1);
  f.children[0]!.emit("close", null, "SIGKILL");
  await rejected;
  await tick();
  assert.equal(releases, 1);
  // Any actual post-settlement close command is cleanup, never input replay.
  for (const child of f.children.slice(1)) child.emit("close", 0, null);
  await tick();
  assert.equal(f.counts().quit, 0);
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().quit, 1);
  assert.equal(f.counts().stops, 1);
});

test("real Computer startup probe fails readiness without fallback while unclosed child remains owned", async () => {
  const f = fixture();
  const bootstrap = new ZenXBootstrapFence();
  let initialized = false;
  const execution = bootstrap.run(async () => {
    await selectComputerProvider({
      userDataDirectory: "/tmp/synthetic-readiness",
      platform: "darwin",
      environment: { PATH: "", ZENX_PEEKABOO_CLI: process.execPath },
      runner: f.runner,
    });
    initialized = true;
  });
  await assert.rejects(
    execution,
    (error: unknown) =>
      error instanceof LifecycleWaitUnconfirmedError &&
      error.message.includes("termination is unconfirmed"),
  );
  assert.equal(initialized, false);
  assert.equal(f.counts().spawns, 1);
  assert.equal(f.counts().kills, 1);
  const host = f.lifecycle(
    async () => {},
    () => bootstrap.cancelAndJoin(),
  );
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().quit, 0);
  assert.equal(
    f.counts().stops,
    0,
    "cannot clean up concurrently with an unjoined startup child",
  );
  assert.equal(f.reports.length, 1);
  f.children[0]!.emit("close", null, "SIGKILL");
  await tick();
  assert.equal(f.counts().quit, 0);
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().quit, 1);
  assert.equal(f.counts().stops, 1);
});

test("Playwright startup uses the same readiness failure boundary without releasing the launch lease", async () => {
  const f = fixture();
  let releases = 0;
  await assert.rejects(
    probePlaywrightCli(
      "/synthetic/playwright",
      f.runner,
      undefined,
      undefined,
      async () => async () => {
        releases++;
      },
    ),
    LifecycleWaitUnconfirmedError,
  );
  assert.deepEqual(
    { kills: f.counts().kills, spawns: f.counts().spawns, releases },
    { kills: 1, spawns: 1, releases: 0 },
  );
  f.children[0]!.emit("close", null, "SIGKILL");
  await tick();
  assert.equal(releases, 1);
});

test("startup deadline fences a delayed launch binding without spawning or releasing it early", async () => {
  const f = fixture();
  let releases = 0;
  let finishBinding!: () => void;
  const binding = new Promise<void>((resolve) => {
    finishBinding = resolve;
  });
  const pending = probePlaywrightCli(
    "/synthetic/playwright",
    f.runner,
    undefined,
    undefined,
    async () => {
      await binding;
      return async () => {
        releases++;
      };
    },
  );
  let failure!: LifecycleWaitUnconfirmedError;
  await assert.rejects(pending, (error: unknown) => {
    if (!(error instanceof LifecycleWaitUnconfirmedError)) return false;
    failure = error;
    return true;
  });
  assert.equal(f.counts().spawns, 0);
  assert.equal(releases, 0);
  finishBinding();
  await assert.rejects(failure.completion, /readiness deadline expired/);
  assert.equal(f.counts().spawns, 0);
  assert.equal(releases, 1);
});

test("Quit during bootstrap is bounded, visible once, and never races cleanup against acquisition", async () => {
  const f = fixture();
  const bootstrap = new ZenXBootstrapFence();
  let finishAcquisition!: () => void;
  const acquisition = new Promise<void>((resolve) => {
    finishAcquisition = resolve;
  });
  const execution = bootstrap.run(async () => {
    await acquisition;
    bootstrap.throwIfCancelled();
  });
  const host = f.lifecycle(
    async () => {},
    () => bootstrap.cancelAndJoin(),
  );
  await tick();
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().stops, 0);
  assert.equal(f.counts().quit, 0);
  assert.equal(f.reports.length, 1);
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.reports.length, 1);
  finishAcquisition();
  await execution;
  await tick();
  assert.equal(f.counts().quit, 0);
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.counts().stops, 1);
  assert.equal(f.counts().quit, 1);
});

test("Quit before the real readiness deadline needs only one subsequent explicit Quit after probe close", async () => {
  const f = fixture();
  const bootstrap = new ZenXBootstrapFence();
  const execution = bootstrap.run(async () => {
    await selectComputerProvider({
      userDataDirectory: "/tmp/synthetic-readiness-early-quit",
      platform: "darwin",
      environment: { PATH: "", ZENX_PEEKABOO_CLI: process.execPath },
      runner: f.runner,
    });
  });
  const failedReadiness = assert.rejects(
    execution,
    LifecycleWaitUnconfirmedError,
  );
  await tick();
  const host = f.lifecycle(
    async () => {},
    () => bootstrap.cancelAndJoin(),
  );
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.equal(f.reports.length, 1);
  assert.equal(f.counts().quit, 0);
  await failedReadiness; // Unchanged production 5s deadline + 1s close grace.
  f.children[0]!.emit("close", null, "SIGKILL");
  await tick();
  assert.equal(f.counts().quit, 0, "close alone must not quit");
  host.beforeQuit(() => {});
  await host.quitCompletion;
  assert.deepEqual(f.counts(), { kills: 1, spawns: 1, quit: 1, stops: 1 });
});

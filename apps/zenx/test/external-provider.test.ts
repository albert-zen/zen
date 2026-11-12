import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ForegroundActivity } from "../src/main/foreground-activity.js";

import {
  parseWindowsNpmShimEntry,
  SystemExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";

test("external provider runner enforces bounded output and timeout", async () => {
  const runner = new SystemExternalProviderProcessRunner();
  await assert.rejects(
    runner.run(process.execPath, ["-e", "console.log('x'.repeat(4096))"], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    }),
    /output limit/u,
  );
  await assert.rejects(
    runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 50,
      maxOutputBytes: 1024,
    }),
    /timed out after 50ms/u,
  );
});

test("external provider runner cancels the child process", async () => {
  const runner = new SystemExternalProviderProcessRunner();
  const controller = new AbortController();
  const pending = runner.run(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      timeoutMs: 5_000,
      signal: controller.signal,
      maxOutputBytes: 1024,
    },
  );
  controller.abort(new DOMException("provider stopped", "AbortError"));
  await assert.rejects(pending, /provider stopped/u);
});

test("parses only the Node entry from a standard Windows npm command shim", () => {
  assert.equal(
    parseWindowsNpmShimEntry(
      '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@playwright\\cli\\playwright-cli.js" %*\r\n',
    ),
    "node_modules\\@playwright\\cli\\playwright-cli.js",
  );
  assert.equal(
    parseWindowsNpmShimEntry("@ECHO off\r\nunknown %*\r\n"),
    undefined,
  );
});

test("bundled runtime execution never consults PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-runtime-runner-"));
  try {
    const script = path.join(root, "provider.js");
    await writeFile(script, "console.log(JSON.stringify({ bundled: true }))\n");
    const runner = new SystemExternalProviderProcessRunner();
    const result = await runner.run(script, [], {
      timeoutMs: 5_000,
      runtimeExecutable: process.execPath,
      maxOutputBytes: 1024,
    });
    assert.equal(result.stdout.trim(), JSON.stringify({ bundled: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external provider runner applies a scoped Playwright browser path", async () => {
  const runner = new SystemExternalProviderProcessRunner();
  const browserPath = path.join(os.tmpdir(), "verified-playwright-browsers");
  const result = await runner.run(
    process.execPath,
    ["-e", "process.stdout.write(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '')"],
    {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      environment: { PLAYWRIGHT_BROWSERS_PATH: browserPath },
    },
  );
  assert.equal(result.stdout, browserPath);
});

test("provider execution suppresses interactive update checks without forwarding secrets", async () => {
  const runner = new SystemExternalProviderProcessRunner();
  const result = await runner.run(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({ update: process.env.NO_UPDATE_NOTIFIER, secret: process.env.ZENX_TEST_SECRET }))",
    ],
    {
      timeoutMs: 5000,
      environment: { NO_UPDATE_NOTIFIER: "", ZENX_TEST_SECRET: "private" },
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), { update: "1" });
});

// Synthetic children only: no application input, focus, or user desktop access.
for (const cause of ["abort", "timeout", "output-limit"] as const) {
  for (const killResult of [
    "sent",
    "false",
    "throws",
    "error event",
  ] as const) {
    test(`external ${cause} waits for close when kill ${killResult}`, async () => {
      const { EventEmitter } = await import("node:events");
      let kills = 0;
      let stopping = 0;
      let releases = 0;
      let settled = false;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {
          kills++;
          if (killResult === "throws") throw new Error("EPERM");
          if (killResult === "error event")
            child.emit("error", new Error("ESRCH"));
          return killResult === "sent";
        },
      });
      const runner = new SystemExternalProviderProcessRunner(
        (() => child) as unknown as typeof import("node:child_process").spawn,
      );
      const controller = new AbortController();
      const owner = new ForegroundActivity({
        presenter: { update: async () => {}, close() {} },
        agentName: () => "Synthetic external provider",
        report() {},
      });
      const pending = owner.run(
        {
          callId: "external-fixture",
          name: "computer_press",
          arguments: {},
          cwd: "/fixture",
          signal: controller.signal,
        },
        (signal, onStopping) =>
          runner.run(process.execPath, [], {
            timeoutMs: cause === "timeout" ? 5 : 5000,
            signal,
            maxOutputBytes: 4,
            onStopping: () => {
              stopping++;
              onStopping?.();
            },
            bindBeforeSpawn: async () => async () => {
              releases++;
            },
          }),
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = assert.rejects(
        pending,
        cause === "abort"
          ? /fixture abort/
          : cause === "timeout"
            ? /timed out/
            : /output limit/,
      );
      await new Promise<void>((r) => setImmediate(r));
      if (cause === "abort") controller.abort(new Error("fixture abort"));
      else if (cause === "output-limit")
        child.stdout.emit("data", Buffer.from("12345"));
      else await new Promise((r) => setTimeout(r, 15));
      assert.equal(kills, 1);
      assert.equal(stopping, 1);
      assert.equal(settled, false);
      assert.equal(releases, 0);
      assert.equal(owner.snapshot.activities[0]?.stopping, true);
      child.emit("exit", null, "SIGKILL");
      child.stderr.emit(
        "data",
        Buffer.from("ignored after termination request"),
      );
      controller.abort();
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(settled, false);
      assert.equal(kills, 1);
      child.emit("close", null, "SIGKILL");
      await rejected;
      assert.equal(releases, 1);
      assert.equal(stopping, 1);
      assert.equal(owner.snapshot.activities.length, 0);
      owner.close();
    });
  }
}

test("external cancellation during launch binding dispatches no process and releases once", async () => {
  let spawns = 0;
  let releases = 0;
  const controller = new AbortController();
  const runner = new SystemExternalProviderProcessRunner((() => {
    spawns++;
    throw new Error("must not spawn");
  }) as typeof import("node:child_process").spawn);
  await assert.rejects(
    runner.run(process.execPath, [], {
      timeoutMs: 1000,
      signal: controller.signal,
      bindBeforeSpawn: async () => {
        controller.abort(new Error("revoked during binding"));
        return async () => {
          releases++;
        };
      },
    }),
    /revoked during binding/,
  );
  assert.equal(spawns, 0);
  assert.equal(releases, 1);
});

test("synchronous external spawn failure releases its lease without waiting for nonexistent close", async () => {
  let releases = 0;
  const runner = new SystemExternalProviderProcessRunner((() => {
    throw new Error("synthetic launch failure");
  }) as typeof import("node:child_process").spawn);
  await assert.rejects(
    runner.run(process.execPath, [], {
      timeoutMs: 1000,
      bindBeforeSpawn: async () => async () => {
        releases++;
      },
    }),
    /synthetic launch failure/,
  );
  assert.equal(releases, 1);
});

test("stopping presentation failure cannot prevent external termination", async () => {
  const runner = new SystemExternalProviderProcessRunner();
  let stopping = 0;
  await assert.rejects(
    runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 20,
      onStopping: () => {
        stopping++;
        throw new Error("presentation lost");
      },
    }),
    /timed out/,
  );
  assert.equal(stopping, 1);
});

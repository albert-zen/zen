import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { ImZenXRuntime } from "../../../packages/zenx-imzenx-plugin/src/runtime.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginCatalogState,
} from "../src/main/capabilities/types.js";
import { ToolEnvironment } from "../../../src/tool.js";
import {
  PluginRuntimeSupervisor,
  bundledPackageRegistration,
  CatalogPluginRuntimeLifecycle,
  type PluginRuntimeRegistration,
} from "../src/main/plugin-runtime.js";

test(
  "IM consumers activate only after publication and complete predecessor retirement",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-publication-"));
    const receipt = path.join(root, "pids");
    const executable = path.join(root, "python-fixture");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs'; import readline from 'node:readline'; const l=readline.createInterface({input:process.stdin}); l.once('line',()=>{fs.appendFileSync(${JSON.stringify(receipt)},process.pid+'\\n');process.stdout.write('{"type":"ready"}\\n');}); l.once('close',()=>process.exit(0));`,
      { mode: 0o700 },
    );
    const { sdk } = createFixturePluginHost({ pluginId: "imzenx" });
    await sdk.storage.set({
      configuration: {
        pythonExecutable: executable,
        cwd: root,
        channelsConfigFile: path.join(root, "channels.json"),
      },
    });
    const listeners = new Set<() => void>();
    const host = {
      dataDirectory: root,
      isServerReady: () => true,
      onServerStatus: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      readConnection: async () => ({
        url: "ws://127.0.0.1:4500",
        authentication: { tokenFile: path.join(root, "token") },
      }),
    };
    const hostSdk = {
      ...sdk,
      query: { ...sdk.query, projects: { list: async () => [] } },
      actions: {
        threads: {
          startTurn: async () => {
            throw new Error("not used by lifecycle test");
          },
        },
      },
    };
    const supervisor = new PluginRuntimeSupervisor(new ToolEnvironment(), {
      hostSdkFor: async () => hostSdk,
    });
    const runtimes: ImZenXRuntime[] = [];
    const manifest = JSON.parse(
      await readFile(
        path.resolve("../../packages/zenx-imzenx-plugin/zenx.plugin.json"),
        "utf8",
      ),
    );
    function runtimePackage(version: string): ZenXCapabilityPackage {
      return {
        manifest: { ...manifest, version },
        invoke: async () => {
          throw new Error("unadmitted package");
        },
        createRuntime: () => {
          const runtime = new ImZenXRuntime(host);
          runtimes.push(runtime);
          return runtime;
        },
      };
    }
    function registration(version: string): PluginRuntimeRegistration {
      return bundledPackageRegistration({
        source: "bundled",
        package: runtimePackage(version),
      });
    }
    async function connected(runtime: ImZenXRuntime) {
      const deadline = Date.now() + 5000;
      while (runtime.status().state !== "connected") {
        assert(Date.now() < deadline, JSON.stringify(runtime.status()));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      await supervisor.start(registration("1.0.0"));
      await connected(runtimes[0]!);
      const oldPid = Number((await readFile(receipt, "utf8")).trim());
      const rejected = await supervisor.stage(registration("1.0.1"), hostSdk, {
        replaceCurrent: true,
      });
      assert.equal(runtimes[1]!.status().state, "waiting-for-activation");
      assert.equal(listeners.size, 1);
      await rejected.rollback();
      assert.equal(runtimes[0]!.status().state, "connected");
      const lease = supervisor.captureHostGeneration(["imzenx_status"]);
      const candidate = await supervisor.stage(registration("1.0.2"), hostSdk, {
        replaceCurrent: true,
      });
      candidate.publish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runtimes[2]!.status().state, "waiting-for-activation");
      assert.equal(
        (await readFile(receipt, "utf8")).trim().split("\n").length,
        1,
      );
      process.kill(oldPid, 0);
      const successorRegistration = registration("1.0.3");
      const successor = await supervisor.stage(successorRegistration, hostSdk, {
        replaceCurrent: true,
      });
      successor.publish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runtimes[3]!.status().state, "waiting-for-activation");
      assert.equal(
        (await readFile(receipt, "utf8")).trim().split("\n").length,
        1,
      );
      supervisor.releaseHostGeneration(lease);
      await connected(runtimes[3]!);
      assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
      assert.equal(listeners.size, 1);
      assert.equal(
        (await readFile(receipt, "utf8")).trim().split("\n").length,
        2,
      );
      // Re-enable the identical registered package before its old lease drains.
      const retained = supervisor.captureHostGeneration(["imzenx_status"]);
      await supervisor.stop("imzenx");
      await supervisor.start(successorRegistration);
      assert.equal(runtimes[4]!.status().state, "waiting-for-activation");
      assert.equal(runtimes[3]!.status().state, "connected");
      assert.equal(listeners.size, 1);
      supervisor.releaseHostGeneration(retained);
      await connected(runtimes[4]!);
      assert.equal(runtimes[3]!.status().state, "stopped");
      assert.equal(listeners.size, 1);
      assert.equal(
        (await readFile(receipt, "utf8")).trim().split("\n").length,
        3,
      );
      await supervisor.stop("imzenx");
      let durable: ZenXPluginCatalogState = {
        disabled: [],
        uninstalled: [],
        packages: {},
      };
      let rejectSave = false;
      const catalog = new ZenXPluginCatalog(
        {
          load: async () => structuredClone(durable),
          save: async (next) => {
            if (rejectSave) throw new Error("catalog save failed");
            durable = structuredClone(next);
          },
        },
        {
          pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
            supervisor,
            registrationFor: bundledPackageRegistration,
          }),
        },
      );
      await catalog.initialize();
      await catalog.install(runtimePackage("1.0.4"), "bundled");
      await connected(runtimes[5]!);
      const duringSave = supervisor.captureHostGeneration(["imzenx_status"]);
      rejectSave = true;
      await assert.rejects(
        catalog.setEnabled("imzenx", false),
        /catalog save failed/,
      );
      assert.equal(catalog.pluginSnapshot().plugins[0]!.lifecycle, "enabled");
      assert.equal(runtimes[5]!.status().state, "connected");
      assert.equal(runtimes[6]!.status().state, "waiting-for-activation");
      assert.equal(listeners.size, 1);
      supervisor.releaseHostGeneration(duringSave);
      await connected(runtimes[6]!);
      assert.equal(runtimes[5]!.status().state, "stopped");
      assert.equal(listeners.size, 1);
      await catalog.close();
    } finally {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(listeners.size, 0);
  },
);

test("failed ancestor retirement cannot be bypassed by replacement or re-enable", async () => {
  const supervisor = new PluginRuntimeSupervisor(new ToolEnvironment());
  const states: string[] = [];
  function registration(
    version: string,
    failure = false,
  ): PluginRuntimeRegistration {
    return {
      identity: { pluginId: "fixture", packageVersion: version },
      definitions: [
        {
          name: "fixture_status",
          description: "status",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      start: async () => {
        const index = states.push("prepared") - 1;
        let closed = false;
        return {
          identity: { pluginId: "fixture", packageVersion: version },
          activate: (barrier) => {
            void barrier.then(
              () => {
                if (!closed) states[index] = "active";
              },
              () => {
                if (!closed) states[index] = "failed";
              },
            );
          },
          invoke: async () => ({ output: "", exitCode: 0 }),
          close: async () => {
            if (failure) throw new Error("consumer refused shutdown");
            closed = true;
            states[index] = "closed";
          },
        };
      },
    };
  }
  await supervisor.start(registration("1.0.0", true));
  for (const version of ["1.0.1", "1.0.2"]) {
    const next = await supervisor.stage(registration(version), undefined, {
      replaceCurrent: true,
    });
    next.publish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(states.at(-1), "failed");
  }
  await supervisor.stop("fixture");
  await supervisor.start(registration("1.0.3"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1), "failed");
  await assert.rejects(supervisor.close(), /shutdown failed/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { ImZenXRuntime } from "../../../packages/zenx-imzenx-plugin/src/runtime.js";
import { ToolEnvironment } from "../../../src/tool.js";
import {
  PluginRuntimeSupervisor,
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
    function registration(version: string): PluginRuntimeRegistration {
      const runtime = new ImZenXRuntime(host);
      runtimes.push(runtime);
      const identity = { pluginId: "imzenx", packageVersion: version };
      return {
        identity,
        definitions: [
          {
            name: "imzenx_status",
            description: "status",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        start: async () => {
          await runtime.start(sdk);
          return {
            identity,
            activate: (previousRetired) => runtime.activate(previousRetired),
            invoke: async () => ({ output: "", exitCode: 0 }),
            close: () => runtime.close(),
          };
        },
      };
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
      supervisor.releaseHostGeneration(lease);
      await connected(runtimes[2]!);
      assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
      assert.equal(listeners.size, 1);
      assert.equal(
        (await readFile(receipt, "utf8")).trim().split("\n").length,
        2,
      );
    } finally {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(listeners.size, 0);
  },
);

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/main/app-server-manager.js";

for (const enabled of [false, true]) {
  test(`host inspection is ${enabled ? "explicitly enabled" : "absent by default"}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-inspector-"));
    const manager = new AppServerManager({
      entryPath: path.resolve("src/main/app-server-host.ts"),
      tokenFile: path.join(directory, "app-server.token"),
      environment: {
        ...process.env,
        ZENX_CONTEXT_INSPECTOR: enabled ? "1" : "",
      },
      hostConfig: {
        cwd: process.cwd(),
        dataDirectory: path.join(directory, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 20000,
    });
    try {
      await manager.start();
      const { thread } = await manager.request("thread/start", {});
      const usage = await manager.readThreadUsage(thread.id);
      assert.equal(usage.inspection !== undefined, enabled);
      if (enabled) assert.ok(usage.inspection?.throughItemId);
      const again = await manager.readThreadUsage(thread.id);
      assert.deepEqual(
        again,
        usage,
        "inspection must not append session state",
      );
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

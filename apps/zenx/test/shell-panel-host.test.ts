import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerManager } from "../src/main/app-server-manager.js";
import type {
  ShellSessionRead,
  ShellSessionSummary,
} from "../../../src/shell-session.js";
import type { ShellPanelListing } from "../src/shell-panel.js";

test("desktop manager reaches the same child Host task; no session survives Host replacement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shell-host-"));
  const manager = new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, "runtime", "token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
  try {
    await manager.start();
    const threadId = (await manager.request("thread/start", {})).thread.id;
    const list = (await manager.shellPanelRequest({
      operation: "list",
      threadId,
    })) as ShellPanelListing;
    assert.equal(list.cwd, directory);
    assert.equal(list.host, "local");
    const session = (await manager.shellPanelRequest({
      operation: "create",
      threadId,
      cols: 80,
      rows: 24,
    })) as ShellSessionSummary;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      const view = (await manager.shellPanelRequest({
        operation: "read",
        threadId,
        taskId: session.taskId,
      })) as ShellSessionRead;
      ready = view.session.inputAvailable;
      if (!ready) await new Promise((r) => setTimeout(r, 20));
    }
    assert(ready);
    const command =
      process.platform === "win32"
        ? "Write-Output ('HOST_' + 'PTY_PROBE')\r"
        : "printf 'HOST_%s\\n' 'PTY_PROBE'\r";
    await manager.shellPanelRequest({
      operation: "write",
      threadId,
      taskId: session.taskId,
      data: command,
    });
    let seen = false;
    for (let i = 0; i < 100 && !seen; i++) {
      const view = (await manager.shellPanelRequest({
        operation: "read",
        threadId,
        taskId: session.taskId,
      })) as ShellSessionRead;
      seen = view.output.includes("HOST_PTY_PROBE");
      if (!seen) await new Promise((r) => setTimeout(r, 20));
    }
    assert(seen);
    await manager.stop();
    await manager.start();
    const after = (await manager.shellPanelRequest({
      operation: "list",
      threadId,
    })) as ShellPanelListing;
    assert.deepEqual(after.sessions, []);
    await assert.rejects(
      () =>
        manager.shellPanelRequest({
          operation: "read",
          threadId,
          taskId: session.taskId,
        }),
      /not found/,
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

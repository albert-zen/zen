import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  observeCompletedUserMessageTitle,
  observeDiscoveredThreadTitle,
} from "../src/main/thread-title-notification.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { readZenXConnectionDescriptor } from "../src/protocol-client/index.js";
import { applyThreadViewNotification } from "../src/renderer/src/thread-view-state.js";

test(
  "IM SDK and the desktop reducer share actual authenticated ZAS user and Agent messages",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-zas-"));
    const descriptorFile = path.join(root, "runtime", "app-server.json");
    const manager = new AppServerManager({
      entryPath: path.resolve("src/main/app-server-host.ts"),
      tokenFile: path.join(root, "runtime", "app-server.token"),
      descriptorFile,
      hostConfig: {
        cwd: root,
        dataDirectory: path.join(root, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10000,
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await manager.start();
      const descriptor = await readZenXConnectionDescriptor(descriptorFile);
      const created = await manager.request("thread/start", {});
      let view = created.thread;
      const discovered: string[] = [];
      const observedTitles: string[] = [];
      const titles = {
        synchronizeNativeName: async () => {},
        observe: async (_id: string, input: string) => {
          observedTitles.push(input);
        },
      };
      manager.onNotification((method, params) => {
        void observeCompletedUserMessageTitle(titles, method, params);
        view = applyThreadViewNotification(view, method, params);
        if (method === "thread/started") {
          const event =
            params as import("../src/protocol-client/index.js").ServerNotificationParams["thread/started"];
          discovered.push(event.thread.id);
          void observeDiscoveredThreadTitle(
            titles,
            async (threadId) =>
              (await manager.request("thread/resume", { threadId })).thread,
            event.thread,
          );
        }
      });
      const imRoot = path.resolve("../imzen");
      const python = path.join(
        imRoot,
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      child = spawn(python, [path.join(imRoot, "tests/zenx_sync_probe.py")], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdin!.write(
        JSON.stringify({
          threadId: created.thread.id,
          settings: {
            IMZEN_APP_SERVER_URL: descriptor.url,
            IMZEN_APP_SERVER_AUTH_TOKEN_FILE:
              descriptor.authentication.tokenFile,
            IMZEN_CWD: root,
            IMZEN_GATEWAY_STATE_FILE: path.join(root, "gateway.sqlite3"),
          },
        }) + "\n",
      );
      const waitFor = async (event: string) => {
        const deadline = Date.now() + 15000;
        while (!stdout.includes(`"event": "${event}"`)) {
          assert.equal(child!.exitCode, null, stderr + stdout);
          if (Date.now() > deadline)
            throw new Error(`IM probe timeout: ${stderr} ${stdout}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      await waitFor("subscribed");
      assert.match(stdout, /Selected thread/);
      await manager.request("turn/start", {
        threadId: created.thread.id,
        input: [{ type: "text", text: "desktop-origin" }],
      });
      await waitFor("synchronized");
      await waitFor("created-from-im");
      assert.equal(
        discovered.filter((id) => id !== created.thread.id).length,
        1,
      );
      const namingDeadline = Date.now() + 2000;
      while (
        !observedTitles.includes("im-new-thread") &&
        Date.now() < namingDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(
        observedTitles.includes("im-new-thread"),
        "IM-created first input must reach desktop automatic naming without selecting the thread",
      );
      const snapshot = await manager.request("thread/read", {
        threadId: created.thread.id,
        includeTurns: true,
      });
      const items = snapshot.thread.turns.flatMap((turn) => turn.items);
      const projected = view.turns.flatMap((turn) => turn.items);
      for (const collection of [items, projected]) {
        assert(
          collection.some(
            (item) =>
              item.type === "userMessage" &&
              item.content.some(
                (part) => part.type === "text" && part.text === "im-origin",
              ),
          ),
        );
        assert(
          collection.some(
            (item) =>
              item.type === "agentMessage" && item.text.includes("im-origin"),
          ),
        );
        assert(
          collection.some(
            (item) =>
              item.type === "agentMessage" &&
              item.text.includes("desktop-origin"),
          ),
        );
      }
    } finally {
      if (child?.exitCode === null) {
        child.stdin!.end();
        const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
        await new Promise((resolve) => child!.once("exit", resolve));
        clearTimeout(timer);
      }
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

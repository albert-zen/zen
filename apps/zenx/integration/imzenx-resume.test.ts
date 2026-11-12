import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const mode of ["cancel", "close", "timeout"] as const) {
  test(
    `real native resume ownership survives ${mode}`,
    { timeout: 15000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-resume-"));
      const tokenFile = path.join(root, "token");
      await writeFile(tokenFile, "synthetic-resume-token", { mode: 0o600 });
      const appServer = new ZenAppServer({
        journal: new InMemoryThreadJournal(),
        runtime: new AgentRuntime({
          toolEnvironment: new ToolEnvironment({ runtimes: [] }),
        }),
        providerRegistry: new ProviderRegistry([
          {
            providerProfileId: "fake",
            adapter: {
              provider: "fake",
              async *stream() {
                yield { type: "text_delta" as const, delta: "synthetic" };
              },
            },
            modelCatalog: new StaticModelCatalog([
              { id: "fake", isDefault: true, contextWindow: 32768 },
            ]),
          },
        ]),
        threadMetadata: new InMemoryThreadMetadataStore(),
        defaults: {
          cwd: root,
          providerProfileId: "fake",
          modelId: "fake",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        },
      });
      const server = await serveCodexWebSocket({
        appServer,
        zenHome: root,
        listen: "ws://127.0.0.1:0",
        bearerToken: "synthetic-resume-token",
      });
      const held = deferred();
      const release = deferred();
      let desktop: ZenXProtocolClient | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let exited: Promise<void> | undefined;
      try {
        desktop = await ZenXProtocolClient.connect({
          url: server.url,
          bearerTokenFile: tokenFile,
          clientInfo: {
            name: "resume-desktop",
            title: "ZenX",
            version: "test",
          },
        });
        const thread = await desktop.request("thread/start", {});
        const other = await desktop.request("thread/start", {});
        const read = appServer.readThread.bind(appServer);
        let nativeReads = 0;
        // Hold the real native method's first read, not a fake response. The
        // protocol still owns its actual subscription barrier and socket events.
        appServer.readThread = async (...args) => {
          nativeReads += 1;
          if (nativeReads === 1) {
            held.resolve();
            await release.promise;
          }
          return read(...args);
        };
        const imRoot = path.resolve("../imzen");
        const python =
          process.env.IMZEN_TEST_PYTHON ??
          path.join(
            imRoot,
            ".venv",
            process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
          );
        child = spawn(
          python,
          [path.join(imRoot, "tests/zenx_resume_probe.py")],
          {
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stderr = "";
        const events: Array<{ event: string; mode?: string }> = [];
        createInterface({ input: child.stdout }).on("line", (line) => {
          const event = JSON.parse(line) as { event: string; mode?: string };
          events.push(event);
          if (event.event === "independent-ready" || event.event === "complete")
            release.resolve();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        exited = new Promise<void>((resolve, reject) => {
          child!.once("error", reject);
          child!.stdin.once("error", reject);
          child!.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`resume probe ${code}/${signal}: ${stderr}`));
          });
        });
        // Observe rejected exit while waiting at a native barrier, too.
        const stopped = exited.then(() => {
          throw new Error("probe exited before native barrier");
        });
        child.stdin.write(
          JSON.stringify({
            url: server.url,
            tokenFile,
            threadId: thread.thread.id,
            otherThreadId: other.thread.id,
            mode,
          }) + "\n",
        );
        await Promise.race([held.promise, stopped]);
        child.stdin.write("native-held\n");
        await exited;
        assert(
          events.some(
            (event) => event.event === "complete" && event.mode === mode,
          ),
        );
        assert.equal(nativeReads, mode === "cancel" ? 3 : 2);
      } finally {
        release.resolve();
        if (child?.exitCode === null) child.kill();
        await exited?.catch(() => {});
        await desktop?.close();
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

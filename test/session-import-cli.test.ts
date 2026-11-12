import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";
import { importModelSelection } from "../apps/cli/src/import-model-selection.js";
import { encodeModelKey } from "../src/protocol/model-key.js";

test("import CLI rejects unavailable/ambiguous model names and resolves exact target IDs", () => {
  const model = (providerProfileId: string) => ({
    id: encodeModelKey({ providerProfileId, modelId: "shared" }),
    model: "shared",
    defaultReasoningEffort: "medium",
  });
  const catalog = { data: [model("one"), model("two")] };
  assert.throws(() => importModelSelection(catalog, "shared"), /ambiguous/u);
  assert.throws(() => importModelSelection(catalog, "missing"), /unavailable/u);
  assert.deepEqual(importModelSelection(catalog, model("two").id), {
    providerProfileId: "two",
    modelId: "shared",
    reasoningEffort: "medium",
  });
});

test("real remote CLI import honors the requested target Host model", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-import-cli-test-"),
  );
  const journal = new InMemoryThreadJournal();
  const env = new ToolEnvironment({ runtimes: [] });
  const app = new ZenAppServer({
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({ toolEnvironment: env }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "remote-profile",
        adapter: {
          provider: "local",
          async *stream() {
            yield { type: "text_delta" as const, delta: "unused" };
          },
        },
        modelCatalog: new StaticModelCatalog([
          { id: "model-a", isDefault: true, contextWindow: 32768 },
          { id: "model-b", contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: directory,
      providerProfileId: "remote-profile",
      modelId: "model-a",
      reasoningEffort: "medium",
      sandbox: "read-only",
      approvalPolicy: "always",
    },
  });
  const server = await serveCodexWebSocket({
    appServer: app,
    zenHome: directory,
    listen: "ws://127.0.0.1:0",
  });
  try {
    const file = path.join(directory, "selected.jsonl");
    await writeFile(
      file,
      [
        {
          type: "session_meta",
          payload: {
            id: "cli-fixture",
            cwd: "/foreign",
            cli_version: "0.146.0",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "synthetic" }],
          },
        },
      ]
        .map((entry) =>
          JSON.stringify({ timestamp: "2026-10-12T00:00:00Z", ...entry }),
        )
        .join("\n"),
    );
    const run = async (model: string) => {
      const source = import.meta.url.endsWith(".ts");
      const cli = fileURLToPath(
        new URL(`../apps/cli/src/cli.${source ? "ts" : "js"}`, import.meta.url),
      );
      const child = spawn(
        process.execPath,
        [
          ...(source ? ["--import", "tsx"] : []),
          cli,
          "import-session",
          file,
          "--commit",
          "--cwd",
          directory,
          "--remote",
          server.url,
          "--model",
          model,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (data) => {
        out += String(data);
      });
      child.stderr.on("data", (data) => {
        err += String(data);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, out, err };
    };
    const imported = await run("model-b");
    assert.equal(imported.code, 0, imported.err);
    const ids = await journal.listThreadIds();
    assert.equal(ids.length, 1);
    const saved = await app.readThread(ids[0]!);
    assert.equal(saved.modelId, "model-b");
    assert.equal(saved.providerProfileId, "remote-profile");
    assert.match((await run("model-b")).out, /already_imported/u);
    const invalid = await run("missing");
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.err, /Import model is unavailable/u);
    assert.equal((await journal.listThreadIds()).length, 1);
  } finally {
    await server.close();
    await env.close();
    await app.closeRuntimeConfiguration();
    await rm(directory, { recursive: true, force: true });
  }
});

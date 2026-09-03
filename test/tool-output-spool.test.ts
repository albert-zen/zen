import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { renderToolOutput, ToolOutputSpool } from "../src/tool-output-spool.js";
import { ShellToolRuntime, type ToolRuntime } from "../src/tool.js";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import {
  testExecutorEnvironment,
  testToolEnvironment,
  type TestToolExecutor,
} from "./tool-fixtures.js";

test("oversized shell output becomes a bounded receipt with readable full output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-test-"));
  const spool = new ToolOutputSpool({ rootDirectory: root });
  try {
    const head = "HEAD-" + "a".repeat(20 * 1024);
    const middle = "-MIDDLE-" + "中".repeat(8 * 1024);
    const tail = "b".repeat(20 * 1024) + "-TAIL";
    const expected = head + middle + tail;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(expected)})`)}`;
    const server = createShellServer(spool, command);
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "run it")
    ).done;

    const snapshot = await server.readThread(thread.id);
    const result = snapshot.items.find((item) => item.type === "tool_result");
    assert(result?.type === "tool_result");
    assert(result.output.includes("HEAD-"));
    assert(result.output.includes("-TAIL"));
    assert(!result.output.includes("-MIDDLE-"));
    assert(Buffer.byteLength(result.output, "utf8") < 40 * 1024);
    const receipt = parseReceipt(result.output);
    const captured = await readFile(receipt.path);
    assert.equal(captured.toString("utf8"), expected);
    assert.equal(receipt.bytes, captured.length);
    assert.equal(
      receipt.sha256,
      createHash("sha256").update(captured).digest("hex"),
    );
    assert.equal(receipt.sourceTruncated, false);
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("small shell output keeps its exact canonical text shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-small-"));
  const spool = new ToolOutputSpool({ rootDirectory: root });
  try {
    const server = createShellServer(
      spool,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("exact small output")')}`,
    );
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "run it")
    ).done;
    const result = (await server.readThread(thread.id)).items.find(
      (item) => item.type === "tool_result",
    );
    assert(result?.type === "tool_result");
    assert.equal(result.output, "exact small output");
    assert.equal(result.exitCode, 0);
    assert(!JSON.stringify(result).includes("capturedBytes"));
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime spools ordinary text while preserving structuredContent unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-provider-"));
  const spool = new ToolOutputSpool({ rootDirectory: root, previewBytes: 12 });
  const tools: TestToolExecutor = {
    definitions: [{ name: "fixture", description: "fixture", inputSchema: {} }],
    execute: async () => ({
      output: "head-middle-tail",
      exitCode: 4,
      contentType: "fixture/value",
      structuredContent: { exact: [1, "two"] },
    }),
  };
  try {
    const server = createToolServer(spool, tools, "fixture", {});
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "run it")
    ).done;
    const result = (await server.readThread(thread.id)).items.find(
      (item) => item.type === "tool_result",
    );
    assert(result?.type === "tool_result");
    assert.equal(result.exitCode, 4);
    assert.deepEqual(result.structuredContent, { exact: [1, "two"] });
    const receipt = parseReceipt(result.output);
    assert.equal(await readFile(receipt.path, "utf8"), "head-middle-tail");
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UTF-8 head and tail stay valid while the full normalized bytes match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-utf8-"));
  const spool = new ToolOutputSpool({ rootDirectory: root, previewBytes: 14 });
  try {
    const expected = "甲乙丙丁戊己庚辛壬癸";
    const capture = await spool.captureText(expected);
    assert.equal(capture.head, "甲乙");
    assert.equal(capture.tail, "壬癸");
    assert(capture.path !== undefined);
    assert.equal(await readFile(capture.path, "utf8"), expected);
    assert(!capture.head.includes("�"));
    assert(!capture.tail.includes("�"));
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stream redaction crosses chunk and UTF-8 decoder boundaries before disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-redact-"));
  const spool = new ToolOutputSpool({ rootDirectory: root, previewBytes: 12 });
  try {
    const capture = spool.beginCapture({ redactedValues: ["密钥SECRET"] });
    const source = Buffer.from("start-密钥SECRET-end-and-padding", "utf8");
    capture.write(source.subarray(0, 8));
    capture.write(source.subarray(8, 13));
    capture.write(source.subarray(13));
    const metadata = await capture.finish();
    assert(metadata.path !== undefined);
    const stored = await readFile(metadata.path, "utf8");
    assert.equal(stored, "start-[REDACTED]-end-and-padding");
    assert(!renderToolOutput(metadata).includes("密钥SECRET"));
    assert(!stored.includes("密钥SECRET"));
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capture hard cap marks the source truncated without claiming its tail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-cap-"));
  const spool = new ToolOutputSpool({
    rootDirectory: root,
    previewBytes: 8,
    maxCaptureBytes: 12,
  });
  try {
    const metadata = await spool.captureText("0123456789-source-tail");
    assert.equal(metadata.capturedBytes, 12);
    assert.equal(metadata.sourceTruncated, true);
    assert.equal(metadata.tail, "89-s");
    assert(metadata.path !== undefined);
    assert.equal(await readFile(metadata.path, "utf8"), "0123456789-s");
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream truncation is explicit even when captured output is small", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-upstream-"));
  const spool = new ToolOutputSpool({ rootDirectory: root });
  try {
    const metadata = await spool.captureText("provider prefix", {
      sourceTruncated: true,
    });
    assert.equal(metadata.output, undefined);
    assert.equal(metadata.sourceTruncated, true);
    assert(metadata.path !== undefined);
    assert.equal(await readFile(metadata.path, "utf8"), "provider prefix");
    assert.match(renderToolOutput(metadata), /^source_truncated: true$/mu);
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("spool failure renders unavailable and preserves provider exit code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-failure-"));
  const notDirectory = path.join(root, "file");
  await writeFile(notDirectory, "occupied", "utf8");
  const spool = new ToolOutputSpool({
    rootDirectory: notDirectory,
    previewBytes: 8,
  });
  try {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("oversized output"); process.exitCode = 7')}`;
    const server = createShellServer(spool, command);
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "run it")
    ).done;
    const result = (await server.readThread(thread.id)).items.find(
      (item) => item.type === "tool_result",
    );
    assert(result?.type === "tool_result");
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /^full_output: unavailable$/mu);
    assert.match(result.output, /^source_truncated: true$/mu);
  } finally {
    await spool.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Host shutdown owns spool cleanup and POSIX permissions are private", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-host-"));
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "zen-host-data-"));
  const spool = new ToolOutputSpool({ rootDirectory: root, previewBytes: 8 });
  const host = createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolOutputSpool: spool,
  });
  try {
    const metadata = await spool.captureText("host-owned-output");
    assert(metadata.path !== undefined);
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(path.dirname(metadata.path))).mode & 0o777,
        0o700,
      );
      assert.equal((await stat(metadata.path)).mode & 0o777, 0o600);
    }
    await host.closeHostResources();
    assert.deepEqual(await readdir(root), []);
  } finally {
    await host.closeHostResources().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("startup best-effort removes only dead-process spool directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-spool-stale-"));
  const stale = path.join(root, "instance-99999999-stale");
  const unrelated = path.join(root, "keep-me");
  await mkdir(stale);
  await mkdir(unrelated);
  const spool = new ToolOutputSpool({ rootDirectory: root, previewBytes: 8 });
  try {
    await spool.captureText("initialize");
    assert.equal(
      (await readdir(root)).includes("instance-99999999-stale"),
      false,
    );
    assert.equal((await readdir(root)).includes("keep-me"), true);
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

function createShellServer(
  spool: ToolOutputSpool,
  command: string,
): ZenAppServer {
  return createToolServer(
    spool,
    new ShellToolRuntime({ toolOutputSpool: spool }),
    "shell",
    { command },
  );
}

function createToolServer(
  spool: ToolOutputSpool,
  tools: TestToolExecutor | ToolRuntime,
  toolName: string,
  toolArguments: Record<string, unknown>,
): ZenAppServer {
  const model: ModelAdapter = {
    provider: "fixture",
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const hasResult = request.messages.some(
        (message) => message.role === "tool",
      );
      if (!hasResult) {
        yield {
          type: "tool_call",
          callId: "tool-1",
          name: toolName,
          arguments: toolArguments,
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
    },
  };
  return new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      toolEnvironment:
        "specification" in tools
          ? testToolEnvironment({ providers: [tools] })
          : testExecutorEnvironment(tools),
      toolOutputSpool: spool,
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

function parseReceipt(output: string): {
  path: string;
  bytes: number;
  sha256: string;
  sourceTruncated: boolean;
} {
  const pathMatch = /^full_output: (.+)$/mu.exec(output);
  const bytesMatch = /^captured_bytes: (\d+)$/mu.exec(output);
  const hashMatch = /^sha256: ([a-f0-9]{64})$/mu.exec(output);
  const truncatedMatch = /^source_truncated: (true|false)$/mu.exec(output);
  assert(pathMatch && bytesMatch && hashMatch && truncatedMatch);
  return {
    path: pathMatch[1]!,
    bytes: Number(bytesMatch[1]),
    sha256: hashMatch[1]!,
    sourceTruncated: truncatedMatch[1] === "true",
  };
}

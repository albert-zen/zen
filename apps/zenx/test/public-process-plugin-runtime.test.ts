import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessPluginRuntime } from "../src/main/plugin-runtime.js";

test("public process helper interoperates with the Host runtime for invoke, cancel, and close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-public-runtime-"));
  const script = path.join(root, "runtime.mjs");
  const protocolLog = path.join(root, "protocol.jsonl");
  const lifecycleLog = path.join(root, "lifecycle.log");
  const sdkPackage = path.resolve(
    import.meta.dirname,
    "../../../packages/zenx-plugin-sdk",
  );
  const scopeDirectory = path.join(root, "node_modules", "@zenx");
  await mkdir(scopeDirectory, { recursive: true });
  await symlink(
    sdkPackage,
    path.join(scopeDirectory, "plugin-sdk"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import { runProcessPlugin } from "@zenx/plugin-sdk";
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  appendFileSync(${JSON.stringify(protocolLog)}, String(chunk));
  return originalWrite(chunk, ...args);
};
runProcessPlugin({
  pluginId: "public-runtime",
  packageVersion: "1.0.0",
  tools: {
    public_runtime_wait: async (input, invocation) => {
      const id = invocation?.id ?? String(input.id);
      appendFileSync(${JSON.stringify(lifecycleLog)}, "start:" + id + "\\n");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Number(input.delay ?? 80));
        invocation?.signal.addEventListener("abort", () => {
          appendFileSync(${JSON.stringify(lifecycleLog)}, "abort:" + id + "\\n");
          clearTimeout(timer);
          setTimeout(resolve, 10);
        }, { once: true });
      });
      appendFileSync(${JSON.stringify(lifecycleLog)}, "settle:" + id + "\\n");
      if (input.reject === true) throw new Error("settled rejection:" + id);
      return { output: id };
    },
  },
});
`,
    "utf8",
  );
  const runtime = await ProcessPluginRuntime.start(
    { pluginId: "public-runtime", packageVersion: "1.0.0" },
    { command: process.execPath, args: [script], cwd: root },
  );
  try {
    assert.deepEqual(
      await runtime.invoke({
        invocationId: "complete-call",
        tool: "public_runtime_wait",
        arguments: { id: "complete-call", delay: 5 },
        context: { callId: "complete-call", cwd: root },
        signal: new AbortController().signal,
      }),
      { output: "complete-call", exitCode: 0 },
    );

    const cancelController = new AbortController();
    const cancelled = runtime.invoke({
      invocationId: "cancel-call",
      tool: "public_runtime_wait",
      arguments: { id: "cancel-call" },
      context: { callId: "cancel-call", cwd: root },
      signal: cancelController.signal,
    });
    await waitUntil(async () =>
      (await readFile(lifecycleLog, "utf8").catch(() => "")).includes(
        "start:cancel-call",
      ),
    );

    const rejectController = new AbortController();
    const rejectedAfterCancel = runtime.invoke({
      invocationId: "cancel-reject-call",
      tool: "public_runtime_wait",
      arguments: { id: "cancel-reject-call", reject: true },
      context: { callId: "cancel-reject-call", cwd: root },
      signal: rejectController.signal,
    });
    await waitUntil(async () =>
      (await readFile(lifecycleLog, "utf8")).includes(
        "start:cancel-reject-call",
      ),
    );
    rejectController.abort(
      new DOMException("cancel rejection publicly", "AbortError"),
    );
    await assert.rejects(rejectedAfterCancel, /cancel rejection publicly/u);
    await waitUntil(async () =>
      (await readFile(lifecycleLog, "utf8")).includes(
        "settle:cancel-reject-call",
      ),
    );
    cancelController.abort(new DOMException("cancel publicly", "AbortError"));
    await assert.rejects(cancelled, /cancel publicly/u);
    await waitUntil(async () =>
      (await readFile(lifecycleLog, "utf8").catch(() => "")).includes(
        "settle:cancel-call",
      ),
    );

    const closing = runtime.invoke({
      invocationId: "close-call",
      tool: "public_runtime_wait",
      arguments: { id: "close-call" },
      context: { callId: "close-call", cwd: root },
      signal: new AbortController().signal,
    });
    void closing.catch(() => undefined);
    await waitUntil(async () =>
      (await readFile(lifecycleLog, "utf8").catch(() => "")).includes(
        "start:close-call",
      ),
    );
    const closeStartedAt = Date.now();
    await runtime.close();
    assert.ok(
      Date.now() - closeStartedAt < 500,
      "public helper should close cooperatively before the Host kill timeout",
    );

    const lifecycle = await readFile(lifecycleLog, "utf8");
    assert.match(lifecycle, /abort:cancel-call/u);
    assert.match(lifecycle, /abort:cancel-reject-call/u);
    assert.match(lifecycle, /abort:close-call/u);
    const responses = (await readFile(protocolLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; id?: string });
    assert.equal(
      responses.some(
        (message) =>
          (message.id === "cancel-call" ||
            message.id === "cancel-reject-call" ||
            message.id === "close-call") &&
          (message.type === "result" || message.type === "error"),
      ),
      false,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

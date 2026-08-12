import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

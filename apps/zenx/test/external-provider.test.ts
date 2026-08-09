import assert from "node:assert/strict";
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

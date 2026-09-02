import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app } from "electron";

import {
  selectBrowserProvider,
  selectComputerProvider,
} from "./capabilities/provider-catalog.js";
import { PACKAGED_PROVIDER_MANIFEST_SHA256 } from "./capabilities/packaged-provider-integrity.js";
import { packagedProviderSmokeExitCode } from "./packaged-provider-smoke-exit.js";
import { createHostedAppServer } from "../../../../apps/cli/src/host.js";
import { ToolEnvironment, type ToolProvider } from "../../../../src/tool.js";
import { ToolOutputSpool } from "../../../../src/tool-output-spool.js";

const portServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    "<!doctype html><title>ZenX packaged provider</title><button aria-label='Packaged target'>Packaged target</button>",
  );
});

void app.whenReady().then(async () => {
  let failure: unknown;
  try {
    assert.equal(
      app.isPackaged,
      true,
      "packaged smoke must run from a packaged application",
    );
    assert.ok(
      process.resourcesPath.length > 0,
      "packaged smoke must use process.resourcesPath",
    );
    const manifestPath = path.join(
      process.resourcesPath,
      "providers",
      "manifest.json",
    );
    const manifestBytes = await readFile(manifestPath);
    assert.equal(
      await sha256(manifestBytes),
      PACKAGED_PROVIDER_MANIFEST_SHA256,
      "packaged manifest must match the immutable build-time digest",
    );
    const browser = await selectBrowserProvider({
      userDataDirectory: path.join(process.resourcesPath, "smoke-user-data"),
      resourcesDirectory: process.resourcesPath,
      bundledProvidersOnly: true,
      bundledManifestSha256: PACKAGED_PROVIDER_MANIFEST_SHA256,
      platform: process.platform,
    });
    const browserDiagnostic = browser.diagnostics.find(
      (diagnostic) =>
        diagnostic.providerId === "playwright-cli" &&
        diagnostic.status === "selected",
    );
    assert.ok(
      browser.backend,
      `bundled Browser provider unavailable: ${JSON.stringify(browser.diagnostics)}`,
    );
    assert.equal(browserDiagnostic?.version, "0.1.18");
    assert.equal(browserDiagnostic?.integrity, "verified");
    assert.equal(
      browserDiagnostic?.executable?.startsWith(process.resourcesPath),
      true,
    );
    const port = await listen();
    const opened = await browser.backend.open(
      "packaged-smoke",
      `http://127.0.0.1:${String(port)}/`,
    );
    const inspected = await browser.backend.inspect(
      "packaged-smoke",
      opened.tabId,
    );
    assert.equal(
      inspected.targets.some((target) => target.name === "Packaged target"),
      true,
    );
    await browser.backend.close();

    const computer = await selectComputerProvider({
      userDataDirectory: path.join(process.resourcesPath, "smoke-user-data"),
      resourcesDirectory: process.resourcesPath,
      bundledProvidersOnly: true,
      bundledManifestSha256: PACKAGED_PROVIDER_MANIFEST_SHA256,
      platform: process.platform,
    });
    if (process.platform === "win32") {
      const computerDiagnostic = computer.diagnostics.find(
        (diagnostic) =>
          diagnostic.providerId === "microsoft-winapp-cli" &&
          diagnostic.status === "selected",
      );
      assert.ok(
        computer.backend,
        `bundled Computer provider unavailable: ${JSON.stringify(computer.diagnostics)}`,
      );
      assert.equal(computerDiagnostic?.version, "0.3.1");
      assert.equal(computerDiagnostic?.integrity, "verified");
      assert.equal(
        computerDiagnostic?.executable?.startsWith(process.resourcesPath),
        true,
      );
      await computer.backend.close();
    }
    const programmaticTool = await runPackagedProgrammaticToolSmoke();
    console.log(
      JSON.stringify(
        {
          passed: true,
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          browser: browserDiagnostic,
          computer: computer.diagnostics,
          bundledOnly: true,
          syntheticFixtures: false,
          programmaticTool,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error;
    console.error("ZenX packaged provider smoke failed", error);
  } finally {
    try {
      await closeServer();
    } catch (error) {
      failure ??= error;
      console.error("ZenX packaged provider smoke cleanup failed", error);
    }
    app.exit(packagedProviderSmokeExitCode(failure));
  }
});

async function listen(): Promise<number> {
  return await new Promise((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", () => {
      portServer.removeListener("error", reject);
      const address = portServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("packaged provider smoke server did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(): Promise<void> {
  if (!portServer.listening) return;
  await new Promise<void>((resolve, reject) =>
    portServer.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
}

async function sha256(bytes: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function runPackagedProgrammaticToolSmoke(): Promise<{
  workerEntry: string;
  nestedReceiptBytes: number;
  abortExitCode: number;
  spoolRemovedOnClose: boolean;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-packaged-programmatic-tool-"),
  );
  const workerEntry = new URL("./code-runtime-worker.js", import.meta.url);
  await access(workerEntry);
  const spoolRoot = path.join(directory, "spool");
  const spool = new ToolOutputSpool({
    rootDirectory: spoolRoot,
    previewBytes: 128,
    maxCaptureBytes: 16 * 1024,
  });
  const nestedProvider: ToolProvider = {
    identity: { kind: "external", id: "packaged-smoke-nested" },
    definitions: [
      {
        name: "packaged_smoke_nested",
        description: "Return deterministic oversized text",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
    execute: async () => ({ output: "nested:".padEnd(4096, "x"), exitCode: 0 }),
  };
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: path.join(directory, "data"),
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    toolPresentation: "both",
    toolEnvironment: new ToolEnvironment({ providers: [nestedProvider] }),
    toolOutputSpool: spool,
    codeRuntimeOptions: { workerUrl: workerEntry, wallTimeMs: 5_000 },
  });
  let receiptPath: string | undefined;
  try {
    const completed = await host.startThread();
    await (
      await host.startTurn(
        completed.id,
        '!tool run_code {"code":"const nodePath = await import(\\"node:path\\"); const nested = await tools.packaged_smoke_nested({}); text({ builtin: nodePath.basename(\\"/smoke/builtin\\"), nestedBytes: nested.output.length });","description":"packaged programmatic smoke"}',
      )
    ).done;
    const completedSnapshot = await host.readThread(completed.id);
    const calls = completedSnapshot.items.filter(
      (item) => item.type === "tool_call",
    );
    assert.deepEqual(
      calls.map((item) => [item.name, item.parentCallId ?? null]),
      [
        ["run_code", null],
        ["packaged_smoke_nested", calls[0]?.callId],
      ],
    );
    const results = completedSnapshot.items.filter(
      (item) => item.type === "tool_result",
    );
    const nestedResult = results.find(
      (item) => item.callId === calls[1]?.callId,
    );
    assert.match(nestedResult?.output ?? "", /\[tool output receipt\]/u);
    assert.match(nestedResult?.output ?? "", /captured_bytes: 4096/u);
    receiptPath = /full_output: (.+)/u.exec(nestedResult?.output ?? "")?.[1];
    assert.ok(
      receiptPath,
      "nested output receipt must expose its temporary path",
    );
    assert.equal((await readFile(receiptPath, "utf8")).length, 4096);
    assert.equal(
      results.at(-1)?.output,
      '{"builtin":"builtin","nestedBytes":4096}',
    );

    const aborted = await host.startThread();
    const running = await host.startTurn(
      aborted.id,
      '!tool run_code {"code":"for (;;) {}","description":"packaged abort smoke"}',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.interruptTurn(aborted.id, running.id);
    const abortedSnapshot = await host.readThread(aborted.id);
    const abortResult = abortedSnapshot.items.find(
      (item) => item.type === "tool_result",
    );
    assert.equal(abortResult?.exitCode, 130);

    return {
      workerEntry: workerEntry.href,
      nestedReceiptBytes: 4096,
      abortExitCode: 130,
      spoolRemovedOnClose: true,
    };
  } finally {
    await host.closeHostResources();
    if (receiptPath !== undefined) {
      await assert.rejects(access(receiptPath), { code: "ENOENT" });
    }
    await rm(directory, { recursive: true, force: true });
  }
}

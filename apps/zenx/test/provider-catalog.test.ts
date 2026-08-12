import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExternalProviderProcessResult,
  ExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";
import {
  probePeekabooCli,
  probePlaywrightCli,
  selectBrowserProvider,
  selectComputerProvider,
} from "../src/main/capabilities/provider-catalog.js";
import {
  BrowserZenXCapabilityPackage,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";

test("requested user-session mode never falls back to an isolated provider", async () => {
  const selection = await selectBrowserProvider({
    userDataDirectory: "/tmp/zenx",
    environment: { ZENX_BROWSER_MODE: "user-session" },
    platform: "win32",
  });
  assert.equal(selection.backend, undefined);
  assert.equal(selection.diagnostics[0]?.providerId, "user-browser-cdp");
  assert.equal(selection.diagnostics[0]?.status, "unavailable");
  assert.equal(selection.diagnostics[0]?.sessionMode, "user-session");
  assert.match(selection.diagnostics[0]?.reason ?? "", /CDP_ENDPOINT/u);
  assert.equal(
    selection.diagnostics.some((entry) => entry.status === "fallback"),
    false,
  );
});

test("selected user-session provider is registered but hidden until explicitly granted", async () => {
  const backend = stubBrowserBackend();
  const selection = await selectBrowserProvider({
    userDataDirectory: "/tmp/zenx",
    environment: {
      ZENX_BROWSER_MODE: "user-session",
      ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
    },
    platform: "win32",
    userBrowserConnector: async () => ({
      backend,
      product: "Chrome/140.0.1.2",
    }),
  });
  assert.equal(selection.backend, backend);
  assert.equal(selection.manifest.provider.id, "user-browser-cdp");
  assert.equal(selection.diagnostics[0]?.sessionMode, "user-session");

  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
    { platform: "win32" },
  );
  await registry.initialize();
  assert.ok(selection.backend);
  registry.register(
    new BrowserZenXCapabilityPackage(selection.backend, selection.manifest),
  );
  assert.deepEqual(registry.hostSnapshot().definitions, []);
  await registry.grant("browser");
  assert.ok(
    registry
      .hostSnapshot()
      .definitions.some(({ name }) => name === "browser_list_tabs"),
  );
  await registry.close();
});

test("invalid browser modes are explicit instead of masquerading as isolated", async () => {
  const selection = await selectBrowserProvider({
    userDataDirectory: "/tmp/zenx",
    environment: { ZENX_BROWSER_MODE: "surprise" },
    platform: "win32",
  });
  assert.equal(selection.backend, undefined);
  assert.equal(selection.diagnostics[0]?.sessionMode, "invalid");
});

test("packaged provider selection never falls back to an unpinned PATH asset", async () => {
  const resourcesDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-packaged-provider-test-"),
  );
  try {
    const browser = await selectBrowserProvider({
      userDataDirectory: resourcesDirectory,
      resourcesDirectory,
      bundledProvidersOnly: true,
      platform: "win32",
      environment: { PATH: "C:\\fake-provider-path" },
    });
    assert.ok(browser.backend);
    assert.equal(browser.diagnostics[0]?.status, "unavailable");
    assert.match(browser.diagnostics[0]?.reason ?? "", /manifest/u);
    await browser.backend.close();

    const computer = await selectComputerProvider({
      userDataDirectory: resourcesDirectory,
      resourcesDirectory,
      bundledProvidersOnly: true,
      platform: "win32",
      environment: { PATH: "C:\\fake-provider-path" },
    });
    assert.equal(computer.backend, undefined);
    assert.match(computer.diagnostics[0]?.reason ?? "", /manifest/u);
  } finally {
    await rm(resourcesDirectory, { recursive: true, force: true });
  }
});

test("pins and validates the Playwright CLI machine-readable contract", async () => {
  const runner = new ScriptedRunner([
    {
      args: ["--json", "--version"],
      stdout: JSON.stringify({ version: "0.1.18" }),
    },
    {
      args: ["--json", "list"],
      stdout: JSON.stringify({
        browsers: [
          {
            name: "default",
            status: "closed",
            version: "1.63.0-alpha-2026-08-05",
          },
        ],
      }),
    },
  ]);
  assert.equal(
    await probePlaywrightCli("/opt/playwright-cli", runner),
    "0.1.18",
  );
  runner.assertComplete();
});

test("rejects incompatible Playwright versions and JSON schema", async () => {
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.0.9" }),
        },
      ]),
    ),
    /expected >=0\.1\.0/u,
  );
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.2.0" }),
        },
      ]),
    ),
    /and <0\.2\.0/u,
  );
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.1.18" }),
        },
        {
          args: ["--json", "list"],
          stdout: JSON.stringify({ browsers: "not-an-array" }),
        },
      ]),
    ),
    /list\.browsers is invalid/u,
  );
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.1.18" }),
        },
      ]),
      "0.1.19",
    ),
    /does not match pinned version/u,
  );
});

test("pins Peekaboo 3.x and reports explicit permission diagnostics", async () => {
  const runner = new ScriptedRunner([
    {
      args: ["--version"],
      stdout: "Peekaboo 3.1.2 (release)\n",
    },
    {
      args: ["tools", "--json"],
      stdout: JSON.stringify({
        success: true,
        data: {
          tools: ["see", "click", "set_value", "image"].map((name) => ({
            name,
            description: `${name} tool`,
          })),
        },
      }),
    },
    {
      args: ["permissions", "status", "--json"],
      stdout: JSON.stringify({
        success: true,
        data: {
          permissions: [
            {
              name: "Screen Recording",
              isRequired: true,
              isGranted: true,
            },
            {
              name: "Accessibility",
              isRequired: true,
              isGranted: false,
            },
          ],
        },
      }),
    },
  ]);
  assert.deepEqual(await probePeekabooCli("/opt/peekaboo", runner), {
    version: "3.1.2",
    permissionSummary: "Screen Recording=granted, Accessibility=missing",
  });
  runner.assertComplete();
});

class ScriptedRunner implements ExternalProviderProcessRunner {
  readonly #steps: Array<{
    args: string[];
    stdout: string;
    stderr?: string;
  }>;

  constructor(
    steps: Array<{ args: string[]; stdout: string; stderr?: string }>,
  ) {
    this.#steps = [...steps];
  }

  async run(
    _executable: string,
    args: readonly string[],
    _options: { timeoutMs: number },
  ): Promise<ExternalProviderProcessResult> {
    const step = this.#steps.shift();
    assert.ok(step, `Unexpected provider call: ${args.join(" ")}`);
    assert.deepEqual(args, step.args);
    return { stdout: step.stdout, stderr: step.stderr ?? "" };
  }

  assertComplete(): void {
    assert.equal(this.#steps.length, 0);
  }
}

function stubBrowserBackend(): ZenXBrowserBackend {
  return {
    async listTabs() {
      return [];
    },
    async open() {
      throw new Error("not used");
    },
    async navigate() {
      throw new Error("not used");
    },
    async inspect() {
      throw new Error("not used");
    },
    async click() {
      throw new Error("not used");
    },
    async type() {
      throw new Error("not used");
    },
    closeTab() {},
    closeSession() {
      return 0;
    },
    close() {},
  };
}

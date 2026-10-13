import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { MemoryZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";
import { useWorkspaceBrowserProvider } from "../src/main/workspace-browser-provider-policy.js";

test("main selects the shared browser by default and honors an explicit provider mode", () => {
  assert.equal(useWorkspaceBrowserProvider({}), true);
  assert.equal(useWorkspaceBrowserProvider({}, "isolated"), true);
  assert.equal(useWorkspaceBrowserProvider({}, "user-session"), true);
  assert.equal(
    useWorkspaceBrowserProvider(
      { ZENX_BROWSER_MODE: "user-session" },
      "isolated",
    ),
    true,
  );
  assert.equal(
    useWorkspaceBrowserProvider(
      { ZENX_BROWSER_MODE: "isolated" },
      "user-session",
    ),
    false,
  );
});

test("authoritative workspace backend wins over a previously committed bundled variant", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-authoritative-browser-"),
  );
  const playwright = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-browser-plugin/variants/playwright.zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ZenXPluginManifestV2;
  const backend = namedBackend("shared-workspace");
  const service = new ZenXCapabilityService({
    userDataDirectory,
    catalogStore: new MemoryZenXPluginCatalogStore({
      disabled: [],
      uninstalled: [],
      packages: {
        browser: { manifest: playwright, source: "bundled" },
      },
    }),
    browserBackend: backend,
    browserBackendAuthoritative: true,
    bundledProvidersOnly: true,
    providerCatalogOptions: { platform: "darwin" },
  });
  try {
    await service.initialize();
    assert.equal(
      service.browserProfilePackage().manifest.provider.id,
      "electron-dedicated-browser",
    );
    const tabs = (await service
      .browserProfilePackage()
      .invoke("browser_list_tabs", {
        callId: "call-1",
        name: "browser_list_tabs",
        arguments: { sessionId: "session" },
        cwd: "/tmp",
        signal: new AbortController().signal,
      })) as Array<{ title: string }>;
    assert.equal(tabs[0]?.title, "shared-workspace");
  } finally {
    await service.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

function namedBackend(title: string): ZenXBrowserBackend {
  return {
    listTabs: async (sessionId) => [
      {
        sessionId,
        tabId: "tab",
        title,
        url: "https://example.test",
        loading: false,
      },
    ],
    open: async () => {
      throw new Error("unused");
    },
    navigate: async () => {
      throw new Error("unused");
    },
    inspect: async () => {
      throw new Error("unused");
    },
    click: async () => {
      throw new Error("unused");
    },
    type: async () => {
      throw new Error("unused");
    },
    closeTab: () => undefined,
    closeSession: () => 0,
    close: () => undefined,
  };
}

test("external opt-in selects the concurrent package without replacing the injected Workspace backend", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-concurrent-service-"),
  );
  const service = new ZenXCapabilityService({
    userDataDirectory,
    browserBackend: namedBackend("Workspace"),
    browserBackendAuthoritative: true,
    connectedBrowserEnabled: true,
    providerCatalogOptions: {
      platform: "darwin",
      environment: { ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222" },
      userBrowserConnector: async () => ({
        backend: namedBackend("External"),
        product: "fixture",
      }),
    },
  });
  try {
    await service.initialize();
    const provider = service.browserProfilePackage();
    assert.equal(provider.manifest.provider.id, "concurrent-browser");
    for (const [name, title, prefix] of [
      ["browser_workspace_list_tabs", "Workspace", "workspace:"],
      ["browser_connected_list_tabs", "External", "connected:"],
    ]) {
      const result = (await provider.invoke(name!, {
        callId: "call",
        name: name!,
        arguments: { sessionId: "same" },
        threadId: "thread",
        cwd: "/tmp",
        signal: new AbortController().signal,
      })) as Array<{ title: string; tabId: string }>;
      assert.equal(result[0]?.title, title);
      assert.ok(result[0]?.tabId.startsWith(prefix!));
    }
  } finally {
    await service.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

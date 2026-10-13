import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import type { ZenXPluginCatalogState } from "../src/main/capabilities/types.js";
import { createDelegatingFirstPartyProfileLoader } from "../src/main/first-party-profile-loader.js";

const prepared = fileURLToPath(
  new URL("../resources/plugins/", import.meta.url),
);
const pnpmCliPath = fileURLToPath(
  new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
);
const tarballs = {
  legacy: "zenx-browser-plugin-user-session-1.0.5.tgz",
  concurrent: "zenx-browser-plugin-concurrent-1.0.6.tgz",
  isolated: "zenx-browser-plugin-electron-1.0.5.tgz",
};
function tracked(title: string) {
  let closed = 0;
  const sessions = new Set<string>();
  let pendingAction: { started(): void; completion: Promise<void> } | undefined;
  const deferAction = () => {
    let started!: () => void;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const dispatched = new Promise<void>((done) => {
      started = done;
    });
    const completion = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    pendingAction = { started, completion };
    return {
      dispatched,
      finish: (error?: Error) =>
        error === undefined ? resolve() : reject(error),
    };
  };
  const backend: ZenXBrowserBackend = {
    bindThreadSession: (id) => {
      sessions.add(id);
    },
    listTabs: async (sessionId) => {
      assert.ok(sessions.has(sessionId), `${title} session must remain leased`);
      return [
        {
          sessionId,
          tabId: "tab",
          title,
          url: "https://example.test/",
          loading: false,
        },
      ];
    },
    open: async () => {
      throw Error("unused");
    },
    navigate: async (sessionId, tabId, url) => {
      assert.ok(
        sessions.has(sessionId),
        "dispatched action must own a live session",
      );
      const action = pendingAction;
      pendingAction = undefined;
      action?.started();
      await action?.completion;
      assert.ok(
        sessions.has(sessionId),
        "upgrade must not revoke a dispatched action",
      );
      return { sessionId, tabId, title, url, loading: false };
    },
    inspect: async () => {
      throw Error("unused");
    },
    click: async () => {
      throw Error("unused");
    },
    type: async () => {
      throw Error("unused");
    },
    closeTab: () => {},
    closeSession: (id) => {
      sessions.delete(id);
      return 0;
    },
    close: () => {
      closed++;
      sessions.clear();
    },
  };
  return { backend, sessions, deferAction, closed: () => closed };
}
const invocation = (name: string) => ({
  name,
  callId: "call",
  threadId: "thread",
  arguments: { sessionId: "session" },
  cwd: process.cwd(),
  signal: new AbortController().signal,
});
async function title(
  service: ZenXCapabilityService,
  name: string,
  generation?: string,
) {
  const result = await service.execute(invocation(name), generation);
  assert.equal(result.exitCode, 0, result.output);
  return (JSON.parse(result.output) as Array<{ title: string }>)[0]?.title;
}

for (const direction of [
  "legacy-to-concurrent",
  "concurrent-to-isolated",
] as const) {
  for (const outcome of [
    "tarball-failure",
    "runtime-failure",
    "catalog-failure",
    "success",
    "success-action-failure",
  ] as const) {
    test(`concurrent profile transaction ${direction}/${outcome}`, async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "zenx-concurrent-transaction-"),
      );
      const userDataDirectory = path.join(root, "data"),
        resourcesDirectory = path.join(root, "resources");
      await cp(prepared, path.join(resourcesDirectory, "plugins"), {
        recursive: true,
      });
      const disk = new JsonZenXPluginCatalogStore(
        path.join(userDataDirectory, "capability-grants.json"),
      );
      let rejectSave = false;
      const store = {
        load: () => disk.load(),
        save: async (state: ZenXPluginCatalogState) => {
          if (rejectSave) {
            rejectSave = false;
            throw Error("fixture Catalog failure");
          }
          await disk.save(state);
        },
      };
      const workspace = tracked("Workspace");
      const external: ReturnType<typeof tracked>[] = [];
      const isolated: ReturnType<typeof tracked>[] = [];
      const create = (
        mode: "legacy" | "concurrent" | "isolated",
        failLoad = false,
      ) => {
        let service!: ZenXCapabilityService,
          loads = 0;
        const loader = createDelegatingFirstPartyProfileLoader(() =>
          service.browserProfilePackage(),
        );
        service = new ZenXCapabilityService({
          userDataDirectory,
          resourcesDirectory,
          pnpmCliPath,
          catalogStore: store,
          bundledProvidersOnly: true,
          workspaceBrowserBackend: workspace.backend,
          ...(mode === "concurrent"
            ? {
                browserBackend: workspace.backend,
                browserBackendAuthoritative: true,
                connectedBrowserEnabled: true,
              }
            : {}),
          providerCatalogOptions: {
            platform: "darwin",
            environment: {
              PATH: "",
              ZENX_BROWSER_MODE:
                mode === "isolated" ? "isolated" : "user-session",
              ZENX_USER_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
            },
            userBrowserConnector: async () => {
              const value = tracked("External");
              external.push(value);
              return { backend: value.backend, product: "fixture" };
            },
            electronBrowserFactory: () => {
              const value = tracked("Isolated");
              isolated.push(value);
              return value.backend;
            },
          },
          trustedProfileLoaders: {
            browser: (module) => {
              if (++loads === 2 && failLoad)
                throw Error("fixture runtime admission failure");
              return loader(module);
            },
          },
        });
        return service;
      };
      const initialMode =
        direction === "legacy-to-concurrent" ? "legacy" : "concurrent";
      const selectedMode =
        direction === "legacy-to-concurrent" ? "concurrent" : "isolated";
      const oldTool =
        initialMode === "legacy"
          ? "browser_list_tabs"
          : "browser_workspace_list_tabs";
      const oldTitle = initialMode === "legacy" ? "External" : "Workspace";
      let first: ZenXCapabilityService | undefined,
        restarted: ZenXCapabilityService | undefined;
      let token: string | undefined;
      let finishAction: (() => void) | undefined;
      try {
        first = create(initialMode);
        await first.initialize();
        await first.installBundledPluginPackage(
          path.join(resourcesDirectory, "plugins", tarballs[initialMode]),
          { pluginId: "browser", packageName: "@zenx/browser-plugin" },
        );
        assert.equal(await title(first, oldTool), oldTitle);
        await first.close();
        first = undefined;
        const before = await disk.load();
        restarted = create(selectedMode, outcome === "runtime-failure");
        await restarted.initialize();
        assert.equal(
          await title(restarted, oldTool),
          oldTitle,
          "committed runtime must route before sync",
        );
        token = restarted.captureHostSnapshot().generationToken;
        const oldPackage = restarted.browserProfilePackage();
        if (outcome === "success-action-failure") {
          // A disabled/re-enabled runtime may share the same provider with an
          // already-retiring generation that still has a captured Host lease.
          await restarted.setEnabled("browser", false);
          await restarted.setEnabled("browser", true);
        }
        if (outcome === "tarball-failure")
          await writeFile(
            path.join(resourcesDirectory, "plugins", tarballs[selectedMode]),
            "corrupt archive",
          );
        if (outcome === "catalog-failure") rejectSave = true;
        if (outcome.startsWith("success")) {
          const oldBackend =
            initialMode === "legacy" ? external.at(-1)! : workspace;
          const oldSessions = [...oldBackend.sessions];
          const action = oldBackend.deferAction();
          finishAction = () => action.finish();
          const actionName =
            initialMode === "legacy"
              ? "browser_navigate"
              : "browser_workspace_navigate";
          const operation = restarted
            .execute(
              {
                ...invocation(actionName),
                arguments: {
                  sessionId: "session",
                  tabId: initialMode === "legacy" ? "tab" : "workspace:tab",
                  url: "https://example.test/action",
                },
              },
              token,
            )
            .then(
              (result) => ({ result, error: undefined }),
              (error: unknown) => ({ result: undefined, error }),
            );
          await action.dispatched;
          await restarted.syncProfileManagedProviderVariants();
          assert.equal(
            await title(restarted, oldTool, token),
            oldTitle,
            "a captured old generation may start a call after commit without redirecting",
          );
          assert.ok(oldSessions.every((id) => oldBackend.sessions.has(id)));
          assert.notEqual(
            (await disk.load()).profileGeneration,
            before.profileGeneration,
          );
          assert.equal(
            await title(
              restarted,
              selectedMode === "concurrent"
                ? "browser_workspace_list_tabs"
                : "browser_list_tabs",
            ),
            selectedMode === "concurrent" ? "Workspace" : "Isolated",
          );
          if (selectedMode === "concurrent")
            assert.equal(
              await title(restarted, "browser_connected_list_tabs"),
              "External",
            );
          restarted.releaseHostGeneration(token!);
          token = undefined;
          await new Promise((resolve) => setImmediate(resolve));
          assert.ok(
            oldSessions.every((id) => oldBackend.sessions.has(id)),
            "an active call keeps its provider alive after the host lease is released",
          );
          action.finish(
            outcome === "success-action-failure"
              ? new Error("fixture dispatched action failed")
              : undefined,
          );
          const settled = await operation;
          if (outcome === "success-action-failure") {
            assert.ok(settled.error instanceof Error);
            assert.equal(
              settled.error.message,
              "fixture dispatched action failed",
            );
          } else {
            assert.equal(settled.error, undefined);
            assert.equal(JSON.parse(settled.result!.output).title, oldTitle);
          }
          await new Promise((resolve) => setImmediate(resolve));
          assert.ok(
            oldSessions.every((id) => !oldBackend.sessions.has(id)),
            "the single supervisor drain releases the retired provider after actual settlement",
          );
          assert.equal(
            await title(
              restarted,
              selectedMode === "concurrent"
                ? "browser_workspace_list_tabs"
                : "browser_list_tabs",
            ),
            selectedMode === "concurrent" ? "Workspace" : "Isolated",
          );
        } else {
          await assert.rejects(
            restarted.syncProfileManagedProviderVariants(),
            outcome === "runtime-failure"
              ? /fixture runtime/
              : outcome === "catalog-failure"
                ? /fixture Catalog/
                : (error: unknown) => error instanceof Error,
          );
          assert.deepEqual(
            await disk.load(),
            before,
            "failed upgrade must preserve exact Catalog and profile generation",
          );
          assert.equal(restarted.browserProfilePackage(), oldPackage);
          assert.equal(await title(restarted, oldTool), oldTitle);
          assert.equal(
            await title(restarted, oldTool, token),
            oldTitle,
            "captured capability generation must retain old runtime",
          );
        }
        assert.equal(
          workspace.closed(),
          0,
          "provider retirement must never close the app-owned Workspace port",
        );
      } finally {
        finishAction?.();
        if (token !== undefined) restarted?.releaseHostGeneration(token);
        await restarted?.close();
        await first?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("retiring a registry detaches only its Workspace sessions", async () => {
  const workspace = tracked("Workspace");
  const old = new BrowserBackendRegistry(workspace.backend),
    next = new BrowserBackendRegistry(workspace.backend);
  try {
    await old.invoke(
      "browser_workspace_list_tabs",
      invocation("browser_workspace_list_tabs"),
    );
    await next.invoke(
      "browser_workspace_list_tabs",
      invocation("browser_workspace_list_tabs"),
    );
    assert.equal(workspace.sessions.size, 2);
    await old.close();
    assert.equal(workspace.sessions.size, 1);
    assert.equal(workspace.closed(), 0);
    await next.invoke(
      "browser_workspace_list_tabs",
      invocation("browser_workspace_list_tabs"),
    );
  } finally {
    await old.close();
    await next.close();
  }
  assert.equal(workspace.sessions.size, 0);
  assert.equal(workspace.closed(), 0);
});

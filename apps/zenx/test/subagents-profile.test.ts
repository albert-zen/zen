import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXSubagentsCapabilityPackage } from "../src/main/capabilities/subagents-package.js";
import {
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import { createDelegatingFirstPartyProfileLoader } from "../src/main/first-party-profile-loader.js";
import { installZenXBundledPluginsAtStartup } from "../src/main/bundled-plugin-startup.js";
import { subagentsManifest } from "../../../packages/zenx-subagents-plugin/src/manifest.js";

const run = promisify(execFile);
test("ordinary Subagents tarball follows trusted profile install, UI commands, model caller identity and enablement", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-subagents-profile-"),
  );
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const resourcesDirectory = path.join(directory, "resources");
  const packageDirectory = path.join(resourcesDirectory, "plugins", "package");
  await mkdir(path.dirname(packageDirectory), { recursive: true });
  await cp(
    path.join(repo, "packages/zenx-subagents-plugin"),
    packageDirectory,
    {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(packageDirectory, "zenx.plugin.json"), "utf8"),
    ),
    subagentsManifest,
  );
  const packed = JSON.parse(
    (
      await run(process.execPath, [
        path.join(repo, "packages/zenx-plugin-sdk/dist/cli.js"),
        "pack",
        packageDirectory,
      ])
    ).stdout,
  );
  const tarball = path.join(
    resourcesDirectory,
    "plugins",
    "zenx-subagents-plugin-1.0.0.tgz",
  );
  await rename(path.join(packageDirectory, packed[0].filename), tarball);
  const calls: unknown[] = [];
  const appServer = {
    projectProjection: new ZenXProjectProjection(),
    request: async (method: string, params: { parentThreadId?: string }) => {
      calls.push({ method, params });
      if (method === "zen/thread/create-child")
        return {
          thread: {
            id: "native-child",
            parentThreadId: params.parentThreadId,
            items: [],
            turns: [],
          },
        };
      throw new Error("unexpected method");
    },
  } as AppServerRequestPort;
  const service = new ZenXSubagentsCapabilityPackage({
    appServer,
    threads: new ZenXSelfControlCapabilityPackage({ appServer }),
    listSummaries: async () => [],
  });
  const host = new ZenXCapabilityService({
    userDataDirectory: path.join(directory, "user-data"),
    bundledProvidersOnly: true,
    resourcesDirectory,
    pnpmCliPath: path.join(repo, "node_modules/pnpm/bin/pnpm.cjs"),
    trustedProfileLoaders: {
      "zenx-subagents": createDelegatingFirstPartyProfileLoader(() => service),
    },
  });
  try {
    await host.initialize();
    await host.installBundledPluginPackage(tarball, {
      pluginId: "zenx-subagents",
      packageName: "@zenx/subagents-plugin",
    });
    assert.equal(
      host.pluginSnapshot().plugins.find((p) => p.id === "zenx-subagents")
        ?.enabled,
      true,
    );
    assert.deepEqual(host.pluginSnapshot().threadHeaders, []);
    assert.equal(host.pluginSnapshot().panels[0]?.id, "subagents");
    const created = await host.execute({
      name: "zenx_subagents_create",
      callId: "model-call",
      canonicalToolCallId: "item-call",
      arguments: { mode: "fresh" },
      cwd: directory,
      threadId: "model-parent",
      signal: new AbortController().signal,
    });
    assert.equal(JSON.parse(created.output).parentThreadId, "model-parent");
    assert.deepEqual(calls[0], {
      method: "zen/thread/create-child",
      params: { parentThreadId: "model-parent", mode: "fresh" },
    });
    const ui = (await host.executePluginCommand("zenx-subagents", "create", {
      parentThreadId: "ui-parent",
      mode: "fresh",
    })) as { threadId: string };
    assert.equal(ui.threadId, "native-child");
    await host.setEnabled("zenx-subagents", false);
    assert.deepEqual(host.pluginSnapshot().threadHeaders, []);
    assert.deepEqual(host.pluginSnapshot().panels, []);
    await assert.rejects(
      host.executePluginCommand("zenx-subagents", "create", {
        parentThreadId: "ui-parent",
        mode: "fresh",
      }),
      /Unknown plugin command/,
    );
    await host.setEnabled("zenx-subagents", true);
    assert.equal(host.hostSnapshot().definitions.length, 4);
    await host.uninstall("zenx-subagents");
    assert.deepEqual(host.hostSnapshot().definitions, []);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup digest-replaces cached Subagents 1.0.0 header with current panel-only manifest and preserves disablement", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-subagents-upgrade-"),
  );
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const resourcesDirectory = path.join(directory, "resources");
  const packageDirectory = path.join(directory, "package");
  const tarball = path.join(
    resourcesDirectory,
    "plugins",
    "zenx-subagents-plugin-1.0.0.tgz",
  );
  await mkdir(path.dirname(tarball), { recursive: true });
  await cp(
    path.join(repo, "packages/zenx-subagents-plugin"),
    packageDirectory,
    {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    },
  );
  const oldManifest = structuredClone(subagentsManifest);
  oldManifest.ui.surfaces.push({
    id: "subagents-header",
    bundleId: "main",
    exportName: "subagents-header",
  });
  const baseline = {
    ...oldManifest,
    tools: oldManifest.tools.map((tool) =>
      tool.name === "zenx_subagents_create"
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...tool.inputSchema.properties,
                mode: { type: "string", enum: ["fresh", "fork"] },
              },
            },
          }
        : tool,
    ),
    contributions: {
      ...oldManifest.contributions,
      threadHeaders: [
        { id: "subagents", surfaceId: "subagents-header", order: 10 },
      ],
    },
  };
  await writeFile(
    path.join(packageDirectory, "zenx.plugin.json"),
    JSON.stringify(baseline),
  );
  await run("tar", ["-czf", tarball, "-C", directory, "package"]);
  const appServer = {
    projectProjection: new ZenXProjectProjection(),
    request: async (method: string, params: { parentThreadId?: string }) => {
      if (method === "zen/thread/create-child")
        return {
          thread: {
            id: "native-side-chat",
            parentThreadId: params.parentThreadId,
            items: [],
            turns: [],
          },
        };
      throw new Error("unexpected native method " + method);
    },
  } as AppServerRequestPort;
  const domain = new ZenXSubagentsCapabilityPackage({
    appServer,
    threads: new ZenXSelfControlCapabilityPackage({ appServer }),
    listSummaries: async () => [],
  });
  const options = {
    userDataDirectory: path.join(directory, "user-data"),
    resourcesDirectory,
    bundledProvidersOnly: true,
    pnpmCliPath: path.join(repo, "node_modules/pnpm/bin/pnpm.cjs"),
    trustedProfileLoaders: {
      "zenx-subagents": createDelegatingFirstPartyProfileLoader(() => domain),
    },
  };
  let host = new ZenXCapabilityService(options);
  try {
    await host.initialize();
    await host.installBundledPluginPackage(tarball, {
      pluginId: "zenx-subagents",
      packageName: "@zenx/subagents-plugin",
    });
    assert.equal(
      host.pluginSnapshot().threadHeaders?.[0]?.surfaceId,
      "subagents-header",
    );
    await host.setEnabled("zenx-subagents", false);
    await host.close();
    await writeFile(
      path.join(packageDirectory, "zenx.plugin.json"),
      JSON.stringify(subagentsManifest),
    );
    await run("tar", ["-czf", tarball, "-C", directory, "package"]);
    host = new ZenXCapabilityService(options);
    await host.initialize();
    const baselinePlugin = host
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === "zenx-subagents")!;
    assert.equal(baselinePlugin.version, "1.0.0");
    assert.equal(baselinePlugin.enabled, false);
    assert.equal(
      await host.bundledPluginPackageCurrent("zenx-subagents", tarball),
      false,
    );
    let replacements = 0;
    const startup = {
      pluginCatalogAvailable: () => host.pluginCatalogAvailable(),
      pluginSnapshot: () => ({
        plugins: [
          ...host.pluginSnapshot().plugins,
          ...["zenx-rooms", "zenx-self-control", "zenx-triggers"].map((id) => ({
            id,
            lifecycle: "uninstalled",
          })),
        ],
      }),
      bundledPluginPackageCurrent: (
        ...args: Parameters<
          ZenXCapabilityService["bundledPluginPackageCurrent"]
        >
      ) => host.bundledPluginPackageCurrent(...args),
      installBundledPluginPackage: (
        ...args: Parameters<
          ZenXCapabilityService["installBundledPluginPackage"]
        >
      ) => {
        replacements += 1;
        return host.installBundledPluginPackage(...args);
      },
      browserProfilePackage: () => {
        throw new Error("unavailable");
      },
      computerProfilePackage: () => {
        throw new Error("unavailable");
      },
      recordBundledPluginStartupError: (_id: string, error: unknown) => {
        throw error;
      },
    } as unknown as ZenXCapabilityService;
    await installZenXBundledPluginsAtStartup(startup, resourcesDirectory);
    assert.equal(replacements, 1);
    assert.equal(
      await host.bundledPluginPackageCurrent("zenx-subagents", tarball),
      true,
    );
    assert.equal(
      host
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === "zenx-subagents")?.enabled,
      false,
    );
    await installZenXBundledPluginsAtStartup(startup, resourcesDirectory);
    assert.equal(replacements, 1);
    await host.setEnabled("zenx-subagents", true);
    assert.deepEqual(host.pluginSnapshot().threadHeaders, []);
    assert.equal(host.pluginSnapshot().panels[0]?.surfaceId, "subagents-panel");
    const created = (await host.executePluginCommand(
      "zenx-subagents",
      "create",
      { parentThreadId: "parent", mode: "side-chat" },
    )) as { threadId: string };
    assert.equal(created.threadId, "native-side-chat");
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, readFile } from "node:fs/promises";
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
    assert.equal(
      host.pluginSnapshot().threadHeaders?.[0]?.surfaceId,
      "subagents-header",
    );
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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { installZenXBundledPluginsAtStartup } from "../src/main/bundled-plugin-startup.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import {
  createDelegatingFirstPartyProfileLoader,
  FIRST_PARTY_PLUGIN_PACKAGES,
} from "../src/main/first-party-profile-loader.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

const run = promisify(execFile);
const definition = FIRST_PARTY_PLUGIN_PACKAGES.triggers;
const pnpmCliPath = fileURLToPath(
  new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
);

test("real bundled profile upgrades Triggers 1.0.0 to 1.0.1 narrow facts without losing stored content", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-triggers-projection-upgrade-"),
  );
  const userDataDirectory = path.join(directory, "user-data");
  const resourcesDirectory = path.join(directory, "resources");
  const plugins = path.join(resourcesDirectory, "plugins");
  await mkdir(plugins, { recursive: true });
  const tarball = path.join(plugins, definition.tarball);
  await cp(
    fileURLToPath(
      new URL(`../resources/plugins/${definition.tarball}`, import.meta.url),
    ),
    tarball,
  );
  const oldDirectory = path.join(directory, "old-package");
  await mkdir(oldDirectory);
  await run("tar", ["-xzf", tarball, "-C", oldDirectory]);
  const oldRoot = path.join(oldDirectory, "package");
  const oldManifestFile = path.join(oldRoot, "zenx.plugin.json");
  const oldPackageFile = path.join(oldRoot, "package.json");
  // The runtime and storage contract are byte-identical across this additive
  // release. Restore exactly the 1.0.0 declared tool surface for the old fixture.
  const oldManifest = JSON.parse(await readFile(oldManifestFile, "utf8"));
  oldManifest.version = "1.0.0";
  oldManifest.tools = oldManifest.tools.filter(
    (tool: { name: string }) => tool.name !== "zenx_triggers_sidebar_facts",
  );
  oldManifest.contributions.commands =
    oldManifest.contributions.commands.filter(
      (command: { id: string }) => command.id !== "sidebar-facts",
    );
  const oldPackage = JSON.parse(await readFile(oldPackageFile, "utf8"));
  oldPackage.version = "1.0.0";
  await writeFile(oldManifestFile, JSON.stringify(oldManifest));
  await writeFile(oldPackageFile, JSON.stringify(oldPackage));
  const oldTarball = path.join(plugins, "zenx-triggers-plugin-1.0.0.tgz");
  await run("tar", ["-czf", oldTarball, "-C", oldDirectory, "package"]);
  const seed: TriggerSnapshot = {
    triggers: [
      {
        id: "kept-trigger",
        threadId: "kept-thread",
        kind: "timer",
        label: "User timer",
        prompt: "PRIVATE_PROMPT",
        active: false,
        createdAt: 1,
        timer: { nextRunAt: 2_000_000_000_000, intervalMinutes: 10 },
        program: { action: { command: "PRIVATE_PROGRAM" } },
      },
    ],
    history: [
      {
        id: "kept-history",
        triggerId: "kept-trigger",
        threadId: "kept-thread",
        kind: "timer",
        reason: "timer",
        prompt: "PRIVATE_HISTORY",
        clientUserMessageId: "kept-input",
        startedAt: 1,
        completedAt: 2,
        status: "completed",
        turnId: "kept-turn",
        error: null,
        sourceThreadId: null,
        sourceTurnId: null,
        sourceRoomId: null,
        sourceRoomMessageId: null,
        replyRoomId: null,
        replyAuthor: null,
        programInvocationId: null,
        programOutcome: null,
        programOutcomes: [],
      },
    ],
    rooms: [
      {
        id: "kept-room",
        name: "User room",
        createdAt: 1,
        members: [],
        messages: [
          {
            id: "kept-message",
            roomId: "kept-room",
            author: "Human",
            kind: "human",
            text: "PRIVATE_ROOM",
            createdAt: 1,
            originThreadId: null,
            originTurnId: null,
          },
        ],
      },
    ],
  };
  await new ZenXTriggerStore(
    path.join(userDataDirectory, "trigger-registry.json"),
  ).write(seed);
  const appServer: ZenXTriggerAppServerPort = {
    request: async () => {
      throw new Error("Projection upgrade must not start work");
    },
    onNotification: () => () => {},
  };
  let domain = await createBundledAutomationPluginService({
    userDataDirectory,
    appServer,
  });
  let hostPackage = new ZenXTriggersCapabilityPackage(domain);
  const options = {
    userDataDirectory,
    resourcesDirectory,
    pnpmCliPath,
    bundledProvidersOnly: true,
    trustedProfileLoaders: {
      "zenx-triggers": createDelegatingFirstPartyProfileLoader(
        () => hostPackage,
      ),
    },
  };
  let capabilities = new ZenXCapabilityService(options);
  const triggerSummary = () =>
    capabilities
      .pluginSnapshot()
      .plugins.find((entry) => entry.id === "zenx-triggers")!;
  const storageFile = path.join(
    userDataDirectory,
    "plugin-data",
    "zenx-triggers",
    "storage.json",
  );
  try {
    await capabilities.initialize();
    await capabilities.installBundledPluginPackage(oldTarball, definition);
    assert.equal(triggerSummary().version, "1.0.0");
    const oldAdmission = triggerSummary().admissionId;
    assert.ok(oldAdmission);
    assert.ok(
      !capabilities
        .pluginSnapshot()
        .commands.some(
          (command) =>
            command.pluginId === "zenx-triggers" &&
            command.id === "sidebar-facts",
        ),
    );
    await assert.rejects(
      capabilities.executePluginCommand("zenx-triggers", "sidebar-facts"),
    );
    const before = await capabilities.executePluginCommand(
      "zenx-triggers",
      "list",
    );
    const storedBefore = JSON.parse(await readFile(storageFile, "utf8"));
    await installZenXBundledPluginsAtStartup(capabilities, resourcesDirectory);
    assert.equal(triggerSummary().version, "1.0.1");
    assert.equal(triggerSummary().profileSource?.packageVersion, "1.0.1");
    assert.notEqual(triggerSummary().admissionId, oldAdmission);
    assert.ok(
      capabilities
        .pluginSnapshot()
        .commands.some(
          (command) =>
            command.pluginId === "zenx-triggers" &&
            command.id === "sidebar-facts",
        ),
    );
    const expected = {
      triggers: [
        {
          id: "kept-trigger",
          threadId: "kept-thread",
          kind: "timer",
          active: false,
          timer: { nextRunAt: 2_000_000_000_000 },
        },
      ],
    };
    assert.deepEqual(
      await capabilities.executePluginCommand("zenx-triggers", "sidebar-facts"),
      expected,
    );
    assert.deepEqual(
      await capabilities.executePluginCommand("zenx-triggers", "list"),
      before,
    );
    assert.deepEqual(
      JSON.parse(await readFile(storageFile, "utf8")),
      storedBefore,
    );
    const beforeSameVersion = triggerSummary();
    await capabilities.installBundledPluginPackage(tarball, definition, {
      allowSameVersionBundledVariant: true,
    });
    assert.equal(triggerSummary().version, beforeSameVersion.version);
    assert.deepEqual(
      triggerSummary().profileSource,
      beforeSameVersion.profileSource,
    );
    assert.notEqual(
      triggerSummary().admissionId,
      beforeSameVersion.admissionId,
    );
    assert.deepEqual(
      await capabilities.executePluginCommand("zenx-triggers", "sidebar-facts"),
      expected,
    );
    assert.deepEqual(
      JSON.parse(await readFile(storageFile, "utf8")),
      storedBefore,
    );
    await capabilities.setEnabled("zenx-triggers", false);
    await capabilities.setEnabled("zenx-triggers", true);
    assert.deepEqual(
      await capabilities.executePluginCommand("zenx-triggers", "sidebar-facts"),
      expected,
    );
    await capabilities.close();
    domain = await createBundledAutomationPluginService({
      userDataDirectory,
      appServer,
    });
    hostPackage = new ZenXTriggersCapabilityPackage(domain);
    capabilities = new ZenXCapabilityService(options);
    await capabilities.initialize();
    assert.equal(triggerSummary().version, "1.0.1");
    assert.deepEqual(
      await capabilities.executePluginCommand("zenx-triggers", "sidebar-facts"),
      expected,
    );
    assert.deepEqual(
      await capabilities.executePluginCommand("zenx-triggers", "list"),
      before,
    );
    assert.deepEqual(
      JSON.parse(await readFile(storageFile, "utf8")),
      storedBefore,
    );
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

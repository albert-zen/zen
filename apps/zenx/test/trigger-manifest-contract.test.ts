import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";

test("published Triggers manifest matches Host tools, commands and navigation contributions", async () => {
  const packaged = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-triggers-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const runtime = new ZenXTriggersCapabilityPackage({} as never).manifest;
  assert.equal(packaged.version, runtime.version);
  assert.deepEqual(packaged.tools, runtime.tools);
  for (const name of ["commands", "pages", "sidebar"] as const)
    assert.deepEqual(
      packaged.contributions[name],
      runtime.contributions?.[name],
    );
});

test("Room and Trigger package, runtime, Host and lockfile versions select storage v2", async () => {
  const { ZenXRoomsCapabilityPackage } =
    await import("../src/main/capabilities/automation-control-package.js");
  const { createZenXTrustedPlugin: roomsRuntime } =
    await import("../../../packages/zenx-rooms-plugin/src/runtime.js");
  const { createZenXTrustedPlugin: triggersRuntime } =
    await import("../../../packages/zenx-triggers-plugin/src/runtime.js");
  const lock = JSON.parse(
    await readFile(
      new URL("../../../package-lock.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [name, version, host, runtime] of [
    [
      "rooms",
      "1.0.9",
      new ZenXRoomsCapabilityPackage({} as never),
      roomsRuntime({} as never),
    ],
    [
      "triggers",
      "1.0.2",
      new ZenXTriggersCapabilityPackage({} as never),
      triggersRuntime({} as never),
    ],
  ] as const) {
    const base = `../../../packages/zenx-${name}-plugin/`;
    const manifest = JSON.parse(
      await readFile(
        new URL(base + "zenx.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    const pkg = JSON.parse(
      await readFile(new URL(base + "package.json", import.meta.url), "utf8"),
    );
    assert.equal(pkg.version, version);
    assert.equal(manifest.version, version);
    assert.equal(host.manifest.version, version);
    assert.equal(manifest.storageVersion, 2);
    assert.equal(host.manifest.storageVersion, 2);
    assert.equal(host.storage.version, 2);
    assert.equal(runtime.storage.version, 2);
    assert.equal(
      lock.packages[`packages/zenx-${name}-plugin`].version,
      version,
    );
    if (name === "rooms") {
      const schema = manifest.tools.find(
        (tool: { name: string }) => tool.name === "zenx_rooms_messages",
      ).inputSchema.properties.snapshot;
      assert.deepEqual(schema.required, [
        "generation",
        "revision",
        "hash",
        "roomId",
        "messageCount",
      ]);
      assert.equal(schema.additionalProperties, false);
    }
  }
});

test("pack and profile selectors use the same Room and Trigger release names without building archives", async () => {
  const pack = await import("../scripts/pack-first-party-plugins.mjs");
  const rooms = await import("../src/main/rooms-profile-loader.js");
  const firstParty = await import("../src/main/first-party-profile-loader.js");
  assert.equal(pack.ZENX_ROOMS_TARBALL, "zenx-rooms-plugin-1.0.9.tgz");
  assert.equal(rooms.ZENX_ROOMS_TARBALL, pack.ZENX_ROOMS_TARBALL);
  assert.equal(
    firstParty.FIRST_PARTY_PLUGIN_PACKAGES.triggers.tarball,
    "zenx-triggers-plugin-1.0.2.tgz",
  );
  assert(
    JSON.stringify(pack.FIRST_PARTY_PLUGINS).includes(
      "zenx-triggers-plugin-1.0.2.tgz",
    ),
  );
});

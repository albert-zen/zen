import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePluginManifest } from "@zenx/plugin-sdk";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";
import { ALWAYS_ON_ASSISTANT_PROMPT } from "../src/main/assistant-preset.js";

const tool = (name: string) => {
  const definition = fleetManifest.tools.find((entry) => entry.name === name);
  assert(definition, `Missing Fleet tool ${name}`);
  return definition;
};

test("Fleet ordinary package and source expose the same lazy facade contract", async () => {
  const packaged = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-fleet-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(packaged, fleetManifest);
  assert.deepEqual(validatePluginManifest(packaged), fleetManifest);

  for (const name of [
    "zenx_fleet_tools",
    "zenx_fleet_execute",
    "zenx_fleet_tool_status",
  ]) {
    const definition = tool(name);
    assert.deepEqual(definition.permissions, ["zenx-fleet.tools"]);
    assert.deepEqual(definition.capabilities, ["zenx.fleet.tools"]);
    assert.equal(definition.interactionMode, "background_safe");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(
      fleetManifest.tools.filter((entry) => entry.name === name).length,
      1,
    );
  }
  assert.deepEqual(tool("zenx_fleet_shell").permissions, ["zenx-fleet.shell"]);
  assert.deepEqual(tool("zenx_fleet_readiness").permissions, [
    "zenx-fleet.read",
  ]);
  assert(fleetManifest.provider?.capabilities.includes("zenx.fleet.tools"));
});

test("Fleet catalog requires explicit target and execute uses exact epoch/generation", () => {
  const catalog = tool("zenx_fleet_tools").inputSchema;
  assert.deepEqual(catalog.required, ["device", "workspace", "targetThreadId"]);
  assert.deepEqual(Object.keys(catalog.properties as object), [
    "device",
    "workspace",
    "targetThreadId",
  ]);

  const execute = tool("zenx_fleet_execute").inputSchema;
  assert.deepEqual(execute.required, [
    "device",
    "deviceKey",
    "workspace",
    "targetThreadId",
    "processEpoch",
    "toolGeneration",
    "name",
    "arguments",
  ]);
  const properties = execute.properties as Record<string, unknown>;
  const deviceKey = properties.deviceKey as Record<string, unknown>;
  assert.equal(deviceKey.type, "string");
  assert.equal(deviceKey.minLength, 1);
  assert.match(String(deviceKey.description), /top-level deviceKey/);
  assert.match(String(deviceKey.description), /changed routes reject/);
  assert.deepEqual(properties.yield_time_ms, {
    type: "integer",
    minimum: 1,
    maximum: 30000,
  });
  assert.deepEqual(properties.timeout_ms, {
    type: "integer",
    minimum: 1,
    maximum: 120000,
  });
  assert.deepEqual(properties.max_output_bytes, {
    type: "integer",
    minimum: 1,
    maximum: 65536,
  });
  const argumentsSchema = properties.arguments as Record<string, unknown>;
  assert.equal(argumentsSchema.type, "object");
  assert.equal(argumentsSchema.additionalProperties, true);
  for (const hostOwned of [
    "admissionId",
    "createdAtMs",
    "expiresAtMs",
    "sourceThreadId",
    "hostId",
  ])
    assert.equal(Object.hasOwn(properties, hostOwned), false);
  assert.deepEqual(tool("zenx_fleet_tool_status").inputSchema.required, [
    "task_id",
  ]);
  assert.deepEqual(
    Object.keys(
      tool("zenx_fleet_tool_status").inputSchema.properties as object,
    ),
    ["task_id"],
  );
});

// These are discoverable guidance contracts, not proof of model compliance.
test("Fleet owns remote HOWTO while PAW points to it and respects machine wishes", () => {
  const guidance = fleetManifest.mainDocument;
  assert.match(guidance, /Choose the machine the user requested/);
  assert.match(guidance, /optional device is Host routing metadata/);
  assert.match(guidance, /call zenx_fleet_tools only after selecting explicit/);
  assert.match(guidance, /generation \(pass this as toolGeneration\)/);
  assert.match(guidance, /deviceKey binds the discovered configured machine/);
  assert.match(guidance, /target_context containing deviceKey/);
  assert.match(guidance, /Host inserts the bound context/);
  assert.match(guidance, /catalog marks excluded entries eligible=false/);
  assert.match(
    guidance,
    /Existing invitations, old grants and shell opt-in do not expand/,
  );
  assert.match(guidance, /typed configuration/);
  assert.match(guidance, /target Host owns execution/);
  assert.match(
    guidance,
    /ordinary wait observes\/cancels that target admission/,
  );
  assert.match(guidance, /There is no duplicate local task or second journal/);
  assert.match(guidance, /reconnect only to observe the same admission/);
  assert.match(
    guidance,
    /Host restart or expired task observation can make the outcome unknown/,
  );
  assert.match(guidance, /Never fall back to local or SSH/);

  assert.ok(Buffer.byteLength(ALWAYS_ON_ASSISTANT_PROMPT, "utf8") <= 4096);
  assert.match(ALWAYS_ON_ASSISTANT_PROMPT, /zenx-fleet via zenx_plugin/);
  assert.match(ALWAYS_ON_ASSISTANT_PROMPT, /read Fleet's HOWTO/);
  assert.match(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /respect the user's requested machine/,
  );
  assert.doesNotMatch(
    ALWAYS_ON_ASSISTANT_PROMPT,
    /zenx_fleet_|zenx_self_control_devices|sourceDevice\/sourceWorkspace|device=local|toolGeneration|toolsEnabled/,
  );
});

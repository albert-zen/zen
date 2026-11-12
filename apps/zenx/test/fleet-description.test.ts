import assert from "node:assert/strict";
import test from "node:test";
import { FleetRouter, parseFleetConfig } from "../src/main/fleet.js";

test("machine descriptions survive both transports and remain discovery guidance, not commands", async () => {
  const config = parseFleetConfig({
    version: 1,
    devices: [
      {
        id: "build",
        label: "Build",
        description:
          "Linux build machine. Use for release tests.\nNo production data.",
        sshHost: "build",
        command: ["node", "/bridge.js"],
        access: "read",
      },
      {
        id: "gpu",
        label: "GPU",
        description: "GPU experiments only",
        transport: "https",
        endpoint: "https://gpu.example:9443",
        hostId: "host-gpu",
        access: "control",
      },
    ],
  });
  assert.equal(
    config.devices[0]!.description,
    "Linux build machine. Use for release tests.\nNo production data.",
  );
  assert.equal(config.devices[1]!.description, "GPU experiments only");
  const router = new FleetRouter(async () => config);
  assert.equal(
    (await router.devices()).find((device) => device.id === "gpu")!.description,
    "GPU experiments only",
  );
  assert.deepEqual(
    config.devices[0]!.transport === "https" ? [] : config.devices[0]!.command,
    ["node", "/bridge.js"],
  );
});

test("machine descriptions are optional and bounded", () => {
  const base = {
    id: "build",
    label: "Build",
    sshHost: "build",
    command: ["node", "/bridge.js"],
    access: "read",
  };
  assert.equal(
    parseFleetConfig({ version: 1, devices: [base] }).devices[0]!.description,
    undefined,
  );
  for (const description of [42, "x".repeat(4001), "\0secret"])
    assert.throws(
      () =>
        parseFleetConfig({ version: 1, devices: [{ ...base, description }] }),
      /configuration/u,
    );
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";

test("Fleet reachability is an observed check timestamp, not a permanent live connection", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failure = false;
  const service = new FleetSettingsService({
    directory,
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    manager: () =>
      ({
        fleetControl: async () => ({ enabled: false, clients: [] }),
      }) as unknown as AppServerManager,
    workspaces: async () => [],
    sshTransport: async () => {
      if (failure) throw new Error("fixture unavailable");
      return { threads: [] };
    },
  });
  const device = {
    id: "build",
    label: "Build",
    description: "Build tests",
    sshHost: "build",
    command: ["node", "/bridge.js"],
    access: "read" as const,
  };
  await service.save({ version: 1, devices: [device] }, 0);
  assert.equal(
    (await service.devices()).find((value) => value.id === "build")!.check
      .state,
    "not_checked",
  );
  await service.test("build");
  const observed = (await service.devices()).find(
    (value) => value.id === "build",
  )!;
  assert.equal(observed.description, "Build tests");
  assert.equal(observed.check.state, "reachable");
  assert.equal(typeof observed.check.checkedAt, "number");
  assert.equal(observed.check.live, false);
  failure = true;
  await assert.rejects(service.test("build"), /fixture unavailable/u);
  assert.equal(
    (await service.devices()).find((value) => value.id === "build")!.check
      .state,
    "failed",
  );
  await service.save(
    { version: 1, devices: [{ ...device, sshHost: "other" }] },
    1,
  );
  assert.equal(
    (await service.devices()).find((value) => value.id === "build")!.check
      .state,
    "not_checked",
  );
});

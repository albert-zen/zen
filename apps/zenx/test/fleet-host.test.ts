import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import {
  FleetHostService,
  type FleetHostConfig,
} from "../src/main/fleet-host.js";
import {
  NativeFleetClient,
  type NativeFleetCredential,
} from "../src/main/fleet-native.js";
import type { NativeFleetDevice } from "../src/main/fleet.js";

test("Fleet Host starts explicit TLS, persists pairing through restart and revokes while stopped", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key.pem"),
    cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await chmod(key, 0o600);
  const host = createHostedAppServer({
    cwd: dir,
    dataDirectory: path.join(dir, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const service = new FleetHostService(host, {
    request: async () => ({ rooms: [] }),
    subscribe: () => () => {},
  });
  t.after(async () => {
    await service.close();
    await host.closeHostResources();
  });
  const config: FleetHostConfig = {
    enabled: true,
    hostId: "test-host",
    bindAddress: "127.0.0.1",
    port: 0,
    tlsCertificateFile: cert,
    tlsKeyFile: key,
    grantFile: path.join(dir, "grants.json"),
    access: "control",
    workspaces: [{ id: "work", label: "Work", cwd: dir }],
  };
  await service.control("configure", config);
  const endpoint = service.status().url!;
  const peer: NativeFleetDevice = {
    transport: "https",
    id: "remote",
    label: "Remote",
    hostId: config.hostId,
    endpoint,
    access: "control",
    workspace: "work",
  };
  const vault = new Map<string, NativeFleetCredential>();
  const client = new NativeFleetClient({
    ca: await readFile(cert),
    credentials: {
      get: async (id) => vault.get(id) ?? null,
      set: async (id, value) => {
        vault.set(id, value);
      },
      delete: async (id) => {
        vault.delete(id);
      },
    },
  });
  const pairing = (await service.control("pair")) as { code: string };
  await client.pair(peer, pairing.code);
  assert.equal((await client.test(peer)).status, "connected");
  const deviceId = vault.get(peer.id)!.deviceId;
  assert.equal(
    JSON.stringify(service.status()).includes(vault.get(peer.id)!.token),
    false,
  );
  assert.equal(JSON.stringify(service.status()).includes("digest"), false);
  const oldEpoch = (await client.test(peer)).processEpoch;
  config.port = Number(new URL(endpoint).port);
  await service.control("configure", config);
  assert.notEqual((await client.test(peer)).processEpoch, oldEpoch);
  await service.control("configure", { ...config, enabled: false });
  assert.equal(service.status().enabled, false);
  await service.control("revoke", deviceId);
  await service.control("configure", config);
  await assert.rejects(client.test(peer));
  await chmod(key, 0o644);
  if (process.platform !== "win32") {
    await assert.rejects(
      service.control("configure", config),
      /private regular file/,
    );
    assert.equal(service.status().enabled, false);
    assert.match(service.status().error!, /private regular file/);
  }
});

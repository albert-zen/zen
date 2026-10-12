import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import { secureLocalEncryption } from "../src/main/secure-local-encryption.js";
import type { LocalEncryption } from "../src/main/credential-vault.js";

async function fixture(t: test.TestContext, encryption?: LocalEncryption) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ action: string; input: any }> = [];
  let failure = false;
  const manager = {
    fleetControl: async (action: string, input: any) => {
      calls.push({ action, input });
      if (action === "configure" && failure) throw new Error("TLS not ready");
      return { enabled: false, clients: [] };
    },
    currentConfiguration: async () => ({ processEpoch: "one" }),
  } as unknown as AppServerManager;
  const service = new FleetSettingsService({
    directory,
    encryption: encryption ?? {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from([...s].reverse().join("")),
      decryptString: (s) => [...s.toString()].reverse().join(""),
    },
    manager: () => manager,
    workspaces: async () => [{ cwd: directory, label: "Test" }],
  });
  return {
    service,
    directory,
    calls,
    fail: () => {
      failure = true;
    },
  };
}
const config = () => ({
  version: 1,
  devices: [],
  hosting: {
    enabled: false,
    bindAddress: "127.0.0.1",
    port: 8443,
    tlsCertificateFile: "",
    tlsKeyFile: "",
    access: "read",
    relayEndpoint: "https://relay.example",
  },
});
test("Fleet settings bind encrypted relay credentials to endpoint and never expose them", async (t) => {
  const { service, directory, calls } = await fixture(t);
  const input = config();
  (input.hosting as any).relayRegistrationToken = "test-secret-one";
  const first = await service.save(input, 0);
  assert.equal((first.host as any).relayConfigured, true);
  assert.equal(JSON.stringify(first).includes("test-secret-one"), false);
  assert.equal(
    (await readFile(service.file, "utf8")).includes("test-secret-one"),
    false,
  );
  assert.equal(
    (await readFile(path.join(directory, "fleet-vault.json"), "utf8")).includes(
      "test-secret-one",
    ),
    false,
  );
  assert.equal(
    calls.find((c) => c.action === "configure")?.input.relayRegistrationToken,
    "test-secret-one",
  );
  const next = config();
  next.hosting.relayEndpoint = "https://other.example";
  const second = await service.save(next, 1);
  assert.equal((second.host as any).relayConfigured, false);
  assert.equal(
    calls.filter((c) => c.action === "configure").at(-1)?.input
      .relayRegistrationToken,
    undefined,
  );
});
test("Fleet saves serialize stale revision rejection and preserve saved-but-offline state", async (t) => {
  const { service, fail } = await fixture(t);
  const results = await Promise.allSettled([
    service.save(config(), 0),
    service.save(config(), 0),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.equal((await service.config()).revision, 1);
  fail();
  const next = config();
  next.hosting.port = 8444;
  await assert.rejects(
    service.save(next, 1),
    /Settings saved, but hosting did not start/,
  );
  assert.equal((await service.config()).revision, 2);
  assert.match(String((await service.status()).host.error), /TLS not ready/);
});
test("Fleet host identity persists and same-epoch restore refreshes without restarting", async (t) => {
  const { service, calls } = await fixture(t);
  const first = (await service.status()).host.hostId;
  await service.save(config());
  await service.restore();
  await service.restore();
  assert.equal((await service.status()).host.hostId, first);
  assert.equal(calls.filter((c) => c.action === "configure").length, 1);
  assert.equal(calls.filter((c) => c.action === "workspaces").length, 2);
  assert.equal(
    calls.filter((c) => c.action === "workspaces/refresh").length,
    3,
  );
});

test("Fleet pairing fails before consuming a code when OS encrypted storage is unavailable", async (t) => {
  const { service } = await fixture(t);
  service.options.encryption.isEncryptionAvailable = () => false;
  let requests = 0;
  service.native.pair = async () => {
    requests++;
    throw new Error("Unexpected pairing request");
  };
  await assert.rejects(
    service.pair({
      id: "peer",
      label: "Peer",
      endpoint: "https://peer.example:9443",
      hostId: "host",
      code: "throwaway",
      access: "read",
    }),
    /requires operating-system credential encryption.*no remote grant was requested/u,
  );
  assert.equal(requests, 0);
  assert.equal((await service.config()).devices.length, 0);
});

for (const backend of ["basic_text", "unknown"] as const) {
  test(`Fleet blocks ${backend} Linux storage before pairing or relay token persistence`, async (t) => {
    let encryptionCalls = 0;
    const encryption = secureLocalEncryption(
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => backend,
        encryptString: () => {
          encryptionCalls++;
          throw new Error("Should not encrypt");
        },
        decryptString: () => {
          encryptionCalls++;
          throw new Error("Should not decrypt");
        },
      },
      "linux",
    );
    const { service } = await fixture(t, encryption);
    let pairingRequests = 0;
    service.native.pair = async () => {
      pairingRequests++;
      throw new Error("Should not request a grant");
    };
    assert.equal(
      (await service.readiness()).prerequisites.credentialEncryption,
      false,
    );
    await assert.rejects(
      service.pair({
        id: "peer",
        label: "Peer",
        endpoint: "https://peer.example:9443",
        hostId: "host",
        code: "fixture-one-use",
        access: "read",
      }),
      /no remote grant was requested/u,
    );
    const input = {
      ...config(),
      hosting: {
        ...config().hosting,
        relayRegistrationToken: "fixture-relay-token",
      },
    };
    await assert.rejects(
      service.save(input, 0),
      /encryption|encrypted|credential/iu,
    );
    assert.equal(pairingRequests, 0);
    assert.equal(encryptionCalls, 0);
    assert.equal((await service.config()).devices.length, 0);
  });
}

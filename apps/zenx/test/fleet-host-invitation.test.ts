import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import {
  encodeFleetInvitation,
  parseFleetInvitation,
  type FleetInvitation,
} from "../src/fleet-invitation.js";

test("Human Fleet invitation uses the existing one-use grant and preserves client read/shell restrictions", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "fleet-invitation-host-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, "key.pem");
  const certificate = path.join(directory, "cert.pem");
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
      certificate,
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
  const appServer = createHostedAppServer({
    cwd: directory,
    dataDirectory: path.join(directory, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const host = new FleetHostService(appServer, {
    request: async () => ({ rooms: [] }),
    subscribe: () => () => {},
  });
  t.after(async () => {
    await host.close();
    await appServer.closeHostResources();
  });
  const config: FleetHostConfig = {
    enabled: true,
    hostId: "fixture-host",
    bindAddress: "127.0.0.1",
    port: 0,
    tlsCertificateFile: certificate,
    tlsKeyFile: key,
    grantFile: path.join(directory, "grants.json"),
    access: "control",
    shellEnabled: true,
    workspaces: [{ id: "work", label: "Work", cwd: directory }],
  };
  const request = (endpoint: string, confirmed = true) => ({
    endpoint,
    label: "Fixture",
    confirmed,
    expected: {
      hostId: config.hostId,
      access: config.access,
      shellEnabled: config.access === "control" && config.shellEnabled === true,
      relayEndpoint: config.relayEndpoint ?? null,
    },
  });
  await assert.rejects(
    host.control("invitation", request("https://localhost:8443")),
    /hosting/u,
  );
  await host.control("configure", config);
  const endpoint = host.status().url!;
  let invitation = (await host.control(
    "invitation",
    request(endpoint),
  )) as FleetInvitation;
  assert.equal(invitation.access, "control");
  assert.equal(invitation.shellEnabled, true);
  assert.deepEqual(
    parseFleetInvitation(encodeFleetInvitation(invitation)),
    invitation,
  );
  // Invalid/unconfirmed endpoints cannot rotate the existing usable grant.
  await assert.rejects(
    host.control("invitation", request(endpoint, false)),
    /confirmation/u,
  );
  await assert.rejects(
    host.control("invitation", request("https://unconfigured.example:8443")),
    /endpoint/u,
  );
  await assert.rejects(
    host.control("invitation", request("https://0.0.0.0:8443")),
    /endpoint/u,
  );
  for (const expected of [
    { ...request(endpoint).expected, hostId: "old-host" },
    { ...request(endpoint).expected, access: "read", shellEnabled: false },
    { ...request(endpoint).expected, shellEnabled: false },
    {
      ...request(endpoint).expected,
      relayEndpoint: "https://other-relay.example",
    },
  ]) {
    await assert.rejects(
      host.control("invitation", { ...request(endpoint), expected }),
      /refresh.*review/iu,
    );
  }
  // The saved/displayed scope can remain read-only while the Host changes
  // after status was sampled. Its atomic admission must reject that consent.
  const settingsDirectory = path.join(directory, "settings");
  await mkdir(settingsDirectory);
  const boundPort = Number(new URL(endpoint).port);
  await host.control("configure", {
    ...config,
    port: boundPort,
    access: "read",
    shellEnabled: false,
  });
  let preservedCode: FleetInvitation | undefined;
  const settings = new FleetSettingsService({
    directory: settingsDirectory,
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    manager: () =>
      ({
        fleetControl: async (action: string, input: unknown) => {
          if (action === "status") {
            const displayed = host.status();
            await host.control("configure", { ...config, port: boundPort });
            preservedCode = (await host.control(
              "invitation",
              request(endpoint),
            )) as FleetInvitation;
            return displayed;
          }
          return await host.control(action, input);
        },
      }) as unknown as AppServerManager,
    workspaces: async () => [],
  });
  // Keep one stable manager object for identity fencing.
  const stableManager = settings.options.manager();
  settings.options.manager = () => stableManager;
  await writeFile(
    settings.file,
    JSON.stringify({
      version: 1,
      revision: 4,
      devices: [],
      hosting: {
        enabled: true,
        bindAddress: config.bindAddress,
        port: boundPort,
        tlsCertificateFile: certificate,
        tlsKeyFile: key,
        access: "read",
        shellEnabled: false,
      },
    }),
  );
  await writeFile(
    path.join(settingsDirectory, "fleet-host-id"),
    config.hostId + "\n",
  );
  await assert.rejects(
    settings.hostInvitation({
      endpoint,
      label: "Displayed read-only",
      confirmed: true,
      expected: {
        revision: 4,
        hostId: config.hostId,
        access: "read",
        shellEnabled: false,
        relayEndpoint: null,
      },
    }),
    /refresh.*review/iu,
  );
  assert(preservedCode);
  invitation = preservedCode;
  const credentials = new Map<string, NativeFleetCredential>();
  const client = new NativeFleetClient({
    ca: await readFile(certificate),
    credentials: {
      get: async (id) => credentials.get(id) ?? null,
      set: async (id, value) => {
        credentials.set(id, value);
      },
      delete: async (id) => {
        credentials.delete(id);
      },
    },
  });
  const peer: NativeFleetDevice = {
    id: "read-client",
    label: "Read client",
    transport: "https",
    endpoint,
    hostId: invitation.hostId,
    access: "read",
    shellEnabled: false,
  };
  await client.pair(peer, invitation.code);
  await assert.rejects(
    client.pair({ ...peer, id: "replayed-client" }, invitation.code),
    /rejected/u,
  );
  const devices = host.status().clients;
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.access, "read");
  assert.equal(devices[0]!.shellEnabled, false);
  const grantFile = await readFile(config.grantFile, "utf8");
  assert.equal(grantFile.includes(invitation.code), false);
  assert.equal(grantFile.includes(credentials.get(peer.id)!.token), false);
  const snapshot = JSON.stringify(host.status());
  assert.equal(snapshot.includes(invitation.code), false);
  assert.equal(snapshot.includes(credentials.get(peer.id)!.token), false);
  assert.equal(snapshot.includes("digest"), false);
  await assert.rejects(
    client.invoke(
      peer,
      {
        version: 1,
        name: "zenx_threads_create",
        arguments: { project: "work" },
        callId: "control-rejected",
      },
      AbortSignal.timeout(1000),
    ),
    /read-only/u,
  );

  const expiring = (await host.control(
    "invitation",
    request(endpoint),
  )) as FleetInvitation;
  assert.throws(
    () =>
      parseFleetInvitation(
        encodeFleetInvitation(expiring),
        expiring.expiresAt + 1,
      ),
    /expired/u,
  );
  const now = Date.now;
  t.mock.method(Date, "now", () => expiring.expiresAt + 1_000);
  try {
    await assert.rejects(
      client.pair({ ...peer, id: "expired-client" }, expiring.code),
      /rejected/u,
    );
  } finally {
    Date.now = now;
  }

  // A valid configured DNS Origin still works when the listener's IP has no
  // certificate SAN. Rejecting that IP must not replace its usable invitation.
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
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  await chmod(key, 0o600);
  config.port = Number(new URL(endpoint).port);
  config.originEndpoint = `https://localhost:${config.port}`;
  await host.control("configure", config);
  const dnsInvitation = (await host.control(
    "invitation",
    request(config.originEndpoint),
  )) as FleetInvitation;
  await assert.rejects(
    host.control("invitation", request(host.status().url!)),
    /certificate SAN/u,
  );
  const dnsClient = new NativeFleetClient({
    ca: await readFile(certificate),
    credentials: {
      get: async (id) => credentials.get(id) ?? null,
      set: async (id, value) => {
        credentials.set(id, value);
      },
      delete: async (id) => {
        credentials.delete(id);
      },
    },
  });
  await dnsClient.pair(
    { ...peer, id: "dns-client", endpoint: config.originEndpoint },
    dnsInvitation.code,
  );
  assert.equal(host.status().clients.length, 2);
  const oldHostScope = request(config.originEndpoint).expected;
  config.hostId = "replacement-host";
  config.grantFile = path.join(directory, "replacement-grants.json");
  await host.control("configure", config);
  const replacementInvitation = (await host.control(
    "invitation",
    request(config.originEndpoint),
  )) as FleetInvitation;
  await assert.rejects(
    host.control("invitation", {
      ...request(config.originEndpoint),
      expected: oldHostScope,
    }),
    /refresh.*review/iu,
  );
  await dnsClient.pair(
    {
      ...peer,
      id: "replacement-client",
      endpoint: config.originEndpoint,
      hostId: config.hostId,
    },
    replacementInvitation.code,
  );
  assert.equal(host.status().clients.length, 1);
  await host.control("configure", { ...config, enabled: false });
  await assert.rejects(
    host.control("invitation", request(endpoint)),
    /hosting/u,
  );
  assert.equal(host.status().enabled, false);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import { ZenXFleetCapabilityPackage } from "../src/main/capabilities/fleet-package.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import {
  parseFleetInvitation,
  type FleetInvitation,
  type FleetInvitationHostConsent,
} from "../src/fleet-invitation.js";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ action: string; input: unknown }> = [];
  let host: Record<string, unknown> = { enabled: false, clients: [] };
  let statusAction: (() => Promise<void>) | undefined;
  const manager = {
    fleetControl: async (action: string, input: unknown) => {
      calls.push({ action, input });
      if (action === "invitation") {
        const data = input as {
          endpoint: string;
          label: string;
          expected: FleetInvitationHostConsent;
        };
        return {
          version: 1,
          hostId: "fixture-host",
          endpoint: data.endpoint,
          label: data.label,
          expiresAt: Date.now() + 299_000,
          access: data.expected.access,
          shellEnabled: data.expected.shellEnabled,
          code: "fixture_one_use_pairing_code_12345678901234567",
        } satisfies FleetInvitation;
      }
      if (action === "status") await statusAction?.();
      return host;
    },
    currentConfiguration: async () => ({ processEpoch: "one" }),
  } as unknown as AppServerManager;
  const service = new FleetSettingsService({
    directory,
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from([...s].reverse().join("")),
      decryptString: (s) => [...s.toString()].reverse().join(""),
    },
    manager: () => manager,
    workspaces: async () => [{ cwd: directory, label: "Test" }],
    sshTransport: async () => {
      throw new Error("probe-secret-token");
    },
  });
  return {
    service,
    directory,
    calls,
    duringStatus: (action: () => Promise<void>) => {
      statusAction = action;
    },
    host: (value: typeof host) => {
      host = value;
    },
  };
}
const hosting = () => ({
  enabled: true,
  bindAddress: "127.0.0.1",
  port: 8443,
  tlsCertificateFile: "/fixture/private-certificate.pem",
  tlsKeyFile: "/fixture/private-key.pem",
  access: "read" as const,
  originEndpoint: "https://host.example:8443",
});

test("Fleet readiness is read-only for a fresh profile and names the network limits", async (t) => {
  const { service, directory, calls } = await fixture(t);
  const readiness = await service.readiness();
  assert.equal(readiness.host.hostId, null);
  assert.equal(readiness.host.enabled, false);
  assert.equal(readiness.prerequisites.credentialEncryption, true);
  assert.equal(readiness.prerequisites.tlsConfigured, false);
  assert.equal(readiness.devices[0]!.id, "local");
  assert.equal(readiness.devices[0]!.check.live, false);
  assert.match(readiness.limits.join(" "), /no.*scan|No.*scan/u);
  assert.match(
    readiness.limits.join(" "),
    /different networks|Different networks/u,
  );
  assert.deepEqual(
    calls.map(({ action }) => action),
    ["status"],
  );
  assert.deepEqual(await readdir(directory), []);
});

test("Fleet readiness projects configured checks and Host facts without credential or key material", async (t) => {
  const { service, calls, host } = await fixture(t);
  await service.save({
    version: 1,
    devices: [
      {
        id: "ssh",
        label: "Build",
        access: "read",
        sshHost: "build",
        command: ["zen"],
      },
    ],
    hosting: {
      ...hosting(),
      enabled: false,
      relayEndpoint: "https://relay.example",
      relayRegistrationToken: "relay-secret-token",
    },
  });
  host({
    enabled: true,
    hostId: "fixture-host",
    url: "https://host.example:8443",
    relayConnected: true,
    code: "pairing-secret-code",
    token: "grant-secret-token",
    digest: "grant-secret-digest",
    tlsKey: "private-key-material",
    error: "contains relay-secret-token",
    clients: [{ token: "client-secret-token" }],
  });
  await assert.rejects(service.test("ssh"), /probe-secret-token/u);
  calls.length = 0;
  const readiness = await service.readiness();
  assert.equal(readiness.host.hostId, "fixture-host");
  assert.equal(readiness.host.relayConfigured, true);
  assert.equal(readiness.devices[1]!.check.state, "failed");
  assert.equal(readiness.devices[1]!.check.live, false);
  assert.equal(typeof readiness.devices[1]!.check.checkedAt, "number");
  assert.match(readiness.host.error!, /settings/u);
  const serialized = JSON.stringify(readiness);
  for (const secret of [
    "relay-secret-token",
    "pairing-secret-code",
    "grant-secret-token",
    "grant-secret-digest",
    "private-key-material",
    "client-secret-token",
    "probe-secret-token",
    "private-certificate.pem",
    "private-key.pem",
  ])
    assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(
    calls.map(({ action }) => action),
    ["status"],
  );
});

test("Fleet invitation requires human confirmation, configured enabled Host and its existing endpoint before issuance", async (t) => {
  const { service, calls, host } = await fixture(t);
  const input = {
    endpoint: "https://host.example:8443",
    label: "Work",
    confirmed: true as const,
    expected: {
      revision: 0,
      hostId: "fixture-host",
      access: "read",
      shellEnabled: false,
      relayEndpoint: null,
    },
  };
  await assert.rejects(service.hostInvitation(input), /hosting|Host/u);
  assert.equal(
    calls.some(({ action }) => action === "invitation"),
    false,
  );
  await writeFile(
    service.file,
    JSON.stringify({ version: 1, devices: [], hosting: hosting() }),
  );
  await writeFile(
    path.join(service.options.directory, "fleet-host-id"),
    "fixture-host\n",
  );
  host({
    enabled: true,
    hostId: "fixture-host",
    url: "https://127.0.0.1:8443",
  });
  await assert.rejects(
    service.hostInvitation({ ...input, confirmed: false } as never),
    /confirm/u,
  );
  await assert.rejects(
    service.hostInvitation({
      ...input,
      endpoint: "https://unconfigured.example:8443",
    }),
    /configured|endpoint/u,
  );
  assert.equal(
    calls.some(({ action }) => action === "invitation"),
    false,
  );
  const result = await service.hostInvitation(input);
  assert.deepEqual(parseFleetInvitation(result.serialized), result.invitation);
  assert.equal(result.invitation.access, "read");
  assert.equal(result.invitation.shellEnabled, false);
  assert.equal(
    (await readFile(service.file, "utf8")).includes(result.invitation.code),
    false,
  );
  assert.equal(
    (await service.readiness()).host.hostId,
    result.invitation.hostId,
  );
  assert.equal(
    JSON.stringify(await service.readiness()).includes(result.invitation.code),
    false,
  );
  assert.equal(calls.filter(({ action }) => action === "invitation").length, 1);
});

test("Fleet invitation rejects displayed scope changes before issuing any code", async (t) => {
  const { service, calls, host } = await fixture(t);
  await writeFile(
    service.file,
    JSON.stringify({
      version: 1,
      revision: 7,
      devices: [],
      hosting: { ...hosting(), access: "control", shellEnabled: true },
    }),
  );
  await writeFile(
    path.join(service.options.directory, "fleet-host-id"),
    "fixture-host\n",
  );
  host({
    enabled: true,
    hostId: "fixture-host",
    url: "https://127.0.0.1:8443",
  });
  const input = {
    endpoint: "https://host.example:8443",
    label: "Work",
    confirmed: true,
    expected: {
      revision: 6,
      hostId: "fixture-host",
      access: "read",
      shellEnabled: false,
      relayEndpoint: null,
    },
  };
  await assert.rejects(service.hostInvitation(input), /refresh.*review/iu);
  assert.equal(
    calls.some(({ action }) => action === "invitation"),
    false,
  );
  const current = {
    revision: 7,
    hostId: "fixture-host",
    access: "control",
    shellEnabled: true,
    relayEndpoint: null,
  };
  for (const expected of [
    { ...current, revision: 6 },
    { ...current, hostId: "replaced-host" },
    { ...current, access: "read", shellEnabled: false },
    { ...current, shellEnabled: false },
    { ...current, relayEndpoint: "https://other-relay.example" },
  ]) {
    await assert.rejects(
      service.hostInvitation({ ...input, expected }),
      /refresh.*review/iu,
    );
  }
  assert.equal(
    calls.some(({ action }) => action === "invitation"),
    false,
  );
  for (const expected of [
    undefined,
    {},
    { ...current, revision: -1 },
    { ...current, revision: Number.NaN },
    { ...current, access: "admin" },
    { ...current, access: "read", shellEnabled: true },
    { ...current, relayEndpoint: "https://user:password@relay.example" },
    { ...current, extra: "unreviewed" },
  ]) {
    await assert.rejects(
      service.hostInvitation({ ...input, expected }),
      /refresh.*review/iu,
    );
  }
  assert.equal(
    calls.some(({ action }) => action === "invitation"),
    false,
  );
  const result = await service.hostInvitation({ ...input, expected: current });
  assert.equal(result.invitation.access, "control");
  assert.equal(result.invitation.shellEnabled, true);
  assert.deepEqual(calls.find(({ action }) => action === "invitation")!.input, {
    endpoint: input.endpoint,
    label: input.label,
    confirmed: true,
    expected: {
      hostId: current.hostId,
      access: current.access,
      shellEnabled: current.shellEnabled,
      relayEndpoint: current.relayEndpoint,
    },
  });
});

test("Fleet invitation rechecks persisted revision after the Host status await", async (t) => {
  const { service, calls, host, duringStatus } = await fixture(t);
  const config = { version: 1, revision: 2, devices: [], hosting: hosting() };
  await writeFile(service.file, JSON.stringify(config));
  await writeFile(
    path.join(service.options.directory, "fleet-host-id"),
    "fixture-host\n",
  );
  host({
    enabled: true,
    hostId: "fixture-host",
    url: "https://127.0.0.1:8443",
  });
  duringStatus(async () => {
    await writeFile(service.file, JSON.stringify({ ...config, revision: 3 }));
  });
  await assert.rejects(
    service.hostInvitation({
      endpoint: config.hosting.originEndpoint,
      label: "Work",
      confirmed: true,
      expected: {
        revision: 2,
        hostId: "fixture-host",
        access: "read",
        shellEnabled: false,
        relayEndpoint: null,
      },
    }),
    /refresh.*review/iu,
  );
  assert.equal(
    calls.some(({ action }) => action === "invitation"),
    false,
  );
});

test("Ordinary Fleet readiness tool keeps read permission and cannot request invitation issuance", async (t) => {
  const { service, calls } = await fixture(t);
  const plugin = new ZenXFleetCapabilityPackage({
    fleet: service,
    threads: {} as never,
  });
  const invoke = (name: string, args: Record<string, unknown>) =>
    plugin.invoke(name, {
      name,
      arguments: args,
      callId: "call",
      cwd: service.options.directory,
      signal: new AbortController().signal,
    });
  assert.equal(
    ((await invoke("zenx_fleet_readiness", {})) as { source: string }).source,
    "zenx.fleet",
  );
  const tool = fleetManifest.tools.find(
    ({ name }) => name === "zenx_fleet_readiness",
  )!;
  assert.deepEqual(tool.permissions, ["zenx-fleet.read"]);
  assert.deepEqual(tool.capabilities, ["zenx.fleet.read"]);
  await assert.rejects(
    invoke("zenx_fleet_readiness", { confirmed: true }),
    /Unexpected/u,
  );
  await assert.rejects(invoke("zenx_fleet_invitation", {}), /Unsupported/u);
  assert.equal(
    calls.some(({ action }) => action === "pair" || action === "invitation"),
    false,
  );
});

test("Fleet readiness never forwards malformed configuration or Host error payloads", async (t) => {
  const { service, host } = await fixture(t);
  await writeFile(service.file, '{"code":"malformed-private-code"');
  await assert.rejects(service.readiness(), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message.includes("malformed-private-code"), false);
    assert.match(error.message, /settings/u);
    return true;
  });
  await rm(service.file);
  host({
    enabled: false,
    error: "bearer-secret-code",
    code: "bearer-secret-code",
  });
  assert.equal(
    JSON.stringify(await service.readiness()).includes("bearer-secret-code"),
    false,
  );
});

test("Fleet source and ordinary package manifest expose the same read-only readiness contract", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-fleet-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(manifest, fleetManifest);
  assert.equal(
    manifest.tools.filter(
      (tool: { name: string }) => tool.name === "zenx_fleet_readiness",
    ).length,
    1,
  );
  assert.equal(
    manifest.tools.some((tool: { name: string }) =>
      /invitation|pair/u.test(tool.name),
    ),
    false,
  );
});

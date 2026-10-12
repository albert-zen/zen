import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadFleetHeadlessConfig } from "../apps/cli/src/fleet-headless-config.js";

test("production Fleet config is explicit, TLS-only and authorization files stay private", async () => {
  if (process.platform === "win32") {
    await assert.rejects(
      loadFleetHeadlessConfig("C:\\fixture.json"),
      /POSIX private-file validation/,
    );
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-headless-config-"));
  const file = path.join(dir, "host.json");
  const base = {
    enabled: true,
    hostId: "stable-test-host",
    bindAddress: "127.0.0.1",
    port: 4501,
    tlsCertificateFile: path.join(dir, "cert.pem"),
    tlsKeyFile: path.join(dir, "key.pem"),
    grantFile: path.join(dir, "grants.json"),
    pairCodeFile: path.join(dir, "pair-code"),
    access: "read",
    workspaces: [{ id: "test", label: "Fixture", cwd: dir }],
  };
  const load = async (value: unknown) => {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    return await loadFleetHeadlessConfig(file);
  };
  try {
    await writeFile(base.tlsCertificateFile, "fixture-certificate");
    await writeFile(base.tlsKeyFile, "fixture-key", { mode: 0o600 });
    assert.equal((await load(base)).shellEnabled, false);
    for (const [value, pattern] of [
      [{ ...base, enabled: undefined }, /enabled/],
      [{ ...base, enabled: false }, /enabled/],
      [{ ...base, hostId: "" }, /hostId/],
      [{ ...base, bindAddress: undefined }, /bindAddress/],
      [{ ...base, bindAddress: "http://127.0.0.1" }, /explicit IP/],
      [{ ...base, port: undefined }, /explicit port/],
      [{ ...base, access: undefined }, /access/],
      [{ ...base, tlsKeyFile: undefined }, /tlsKeyFile/],
      [{ ...base, grantFile: "relative" }, /absolute/],
      [{ ...base, grantFile: base.tlsKeyFile }, /distinct/],
      [{ ...base, workspaces: [] }, /allowlist/],
      [
        { ...base, workspaces: [...base.workspaces, ...base.workspaces] },
        /Duplicate/,
      ],
      [{ ...base, shellEnabled: true }, /control access/],
      [{ ...base, insecure: true }, /Unknown/],
      [{ ...base, originEndpoint: "http://localhost:4501" }, /Origin/],
      [{ ...base, originEndpoint: "https://localhost:4502" }, /port/],
    ] as const)
      await assert.rejects(load(value), pattern);
    assert.equal(
      (await load({ ...base, access: "control", shellEnabled: true }))
        .shellEnabled,
      true,
    );
    {
      await load(base);
      await chmod(file, 0o644);
      await assert.rejects(loadFleetHeadlessConfig(file), /private/);
      await chmod(file, 0o600);
      await chmod(base.tlsKeyFile, 0o644);
      await assert.rejects(loadFleetHeadlessConfig(file), /private/);
      await chmod(base.tlsKeyFile, 0o600);
      await chmod(dir, 0o755);
      await assert.rejects(loadFleetHeadlessConfig(file), /private/);
      await chmod(dir, 0o700);
      await symlink(base.tlsKeyFile, base.grantFile);
      await assert.rejects(loadFleetHeadlessConfig(file), /private/);
      await rm(base.grantFile);
    }
    await writeFile(
      base.grantFile,
      JSON.stringify({ version: 1, hostId: "wrong-host", devices: [] }),
      { mode: 0o600 },
    );
    await assert.rejects(load(base), /Invalid remote grant/);
    assert.equal(
      (await readFile(base.grantFile, "utf8")).includes("wrong-host"),
      true,
    );
  } finally {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});

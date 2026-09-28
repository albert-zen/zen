import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRemoteHostConfig } from "../apps/cli/src/remote-host-config.js";

test("remote config demands explicit TLS identity, protected file and configured absolute workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-remote-config-"));
  const file = path.join(dir, "remote.json");
  try {
    const base = {
      hostId: "desktop",
      listen: "127.0.0.1",
      port: 0,
      tlsCertFile: path.join(dir, "cert.pem"),
      tlsKeyFile: path.join(dir, "key.pem"),
      pairCodeFile: path.join(dir, "pair.txt"),
      workspaces: [{ id: "ws", label: "Workspace", cwd: dir }],
    };
    await writeFile(base.tlsCertFile, "certificate");
    await writeFile(base.tlsKeyFile, "private key", { mode: 0o600 });
    await writeFile(file, JSON.stringify(base), { mode: 0o600 });
    assert.equal(
      (await loadRemoteHostConfig(file)).workspaces[0]?.cwd,
      await realpath(dir),
    );
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        workspaces: [{ id: "ws", label: "Oops", cwd: "relative" }],
      }),
      { mode: 0o600 },
    );
    await assert.rejects(loadRemoteHostConfig(file), /absolute/);
    if (process.platform !== "win32") {
      await writeFile(file, JSON.stringify(base), { mode: 0o644, flag: "w" });
      const { chmod } = await import("node:fs/promises");
      await chmod(file, 0o644);
      await assert.rejects(loadRemoteHostConfig(file), /private/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

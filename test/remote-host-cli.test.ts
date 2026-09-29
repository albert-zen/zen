import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("explicit isolated CLI Host starts TLS remote endpoint and cleans up pairing file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-remote-cli-"));
  const pairFile = path.join(dir, "pair-code");
  const file = path.join(dir, "remote.json");
  try {
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          path.join(dir, "key.pem"),
          "-out",
          path.join(dir, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
        ],
        { stdio: "ignore" },
      );
    } catch {
      t.skip("OpenSSL unavailable for ephemeral TLS fixture");
      return;
    }
    await chmod(path.join(dir, "key.pem"), 0o600);
    const config = {
      hostId: "isolated-host",
      listen: "127.0.0.1",
      port: 0,
      tlsCertFile: path.join(dir, "cert.pem"),
      tlsKeyFile: path.join(dir, "key.pem"),
      pairCodeFile: pairFile,
      workspaces: [{ id: "ws", label: "Isolated", cwd: dir }],
    };
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        path.resolve("dist/apps/cli/src/cli.js"),
        "app-server",
        "--provider",
        "fake",
        "--data-dir",
        path.join(dir, "host-data"),
        "--cwd",
        dir,
        "--listen",
        "ws://127.0.0.1:0",
        "--remote-host-config",
        file,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const output = await new Promise<string>((resolve, reject) => {
        let text = "";
        const timeout = setTimeout(
          () => reject(new Error(`CLI did not start: ${text}`)),
          15000,
        );
        child.stderr.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("Zen App Server listening")) {
            clearTimeout(timeout);
            resolve(text);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`CLI exited ${String(code)}: ${text}`));
        });
      });
      assert.match(output, /Remote Host enabled at wss:\/\/127\.0\.0\.1:/);
      assert(!output.includes((await readFile(pairFile, "utf8")).trim()));
      if (process.platform !== "win32")
        assert.equal((await stat(pairFile)).mode & 0o077, 0);
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    }
    await assert.rejects(stat(pairFile), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

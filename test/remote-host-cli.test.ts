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
    const exited = once(child, "close");
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
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
    }
    await assert.rejects(stat(pairFile), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "SIGTERM at loopback readiness",
    boundary: "Zen App Server listening",
    signal: "SIGTERM",
  },
  {
    name: "SIGINT at remote readiness",
    boundary: "Remote Host enabled",
    signal: "SIGINT",
  },
  {
    name: "startup failure after pairing",
    boundary: "Remote Host enabled",
    signal: null,
  },
] as const) {
  test(
    `CLI cleans up on ${scenario.name}`,
    { skip: process.platform === "win32" },
    async (t) => {
      const dir = await mkdtemp(
        path.join(os.tmpdir(), "zen-remote-cli-boundary-"),
      );
      const pairFile = path.join(dir, "pair-code");
      const receiptFile = path.join(dir, "receipt.json");
      const exitFile = path.join(dir, "exit.json");
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
        const configFile = path.join(dir, "remote.json");
        await writeFile(
          configFile,
          JSON.stringify({
            hostId: "isolated-host",
            listen: "127.0.0.1",
            port: 0,
            tlsCertFile: path.join(dir, "cert.pem"),
            tlsKeyFile: path.join(dir, "key.pem"),
            pairCodeFile: pairFile,
            workspaces: [{ id: "ws", label: "Isolated", cwd: dir }],
          }),
          { mode: 0o600 },
        );
        const preload = path.join(dir, "boundary.cjs");
        // Only the disposable child is instrumented. A real OS signal is sent
        // synchronously inside the readiness write, before the CLI can continue.
        await writeFile(
          preload,
          `
        const fs = require("node:fs");
        const promises = require("node:fs/promises");
        const { syncBuiltinESMExports } = require("node:module");
        const pairFile = ${JSON.stringify(pairFile)};
        const signal = ${JSON.stringify(scenario.signal)};
        let unlinkCalls = 0;
        const unlink = promises.unlink;
        promises.unlink = async function (file) {
          if (file === pairFile) {
            unlinkCalls += 1;
            // A second signal during cleanup must not bypass either finally.
            if (signal !== null) process.kill(process.pid, signal);
          }
          return unlink.call(this, file);
        };
        syncBuiltinESMExports();
        const write = process.stderr.write;
        let output = "";
        process.stderr.write = function (chunk, ...args) {
          output += String(chunk);
          const result = write.call(this, chunk, ...args);
          if (String(chunk).includes(${JSON.stringify(scenario.boundary)})) {
            fs.writeFileSync(${JSON.stringify(receiptFile)}, JSON.stringify({
              privateMode: (fs.statSync(pairFile).mode & 0o077) === 0,
              secretLogged: output.includes(fs.readFileSync(pairFile, "utf8").trim()),
            }), { mode: 0o600 });
            if (signal === null) throw new Error("synthetic readiness failure");
            process.kill(process.pid, signal);
          }
          return result;
        };
        process.on("exit", () => fs.writeFileSync(${JSON.stringify(exitFile)}, JSON.stringify({
          unlinkCalls,
          sigintListeners: process.listenerCount("SIGINT"),
          sigtermListeners: process.listenerCount("SIGTERM"),
        }), { mode: 0o600 }));
      `,
          { mode: 0o600 },
        );
        const child = spawn(
          process.execPath,
          [
            "--require",
            preload,
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
            configFile,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const exited = once(child, "close");
        let output = "";
        child.stdout.resume();
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
        try {
          const [code, signal] = await exited;
          assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")), {
            privateMode: true,
            secretLogged: false,
          });
          await assert.rejects(stat(pairFile), /ENOENT/);
          assert.equal(signal, null, output);
          assert.equal(code, scenario.signal === null ? 1 : 0, output);
          assert.deepEqual(JSON.parse(await readFile(exitFile, "utf8")), {
            unlinkCalls: 1,
            sigintListeners: 0,
            sigtermListeners: 0,
          });
          if (scenario.signal === null)
            assert.match(output, /synthetic readiness failure/);
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await exited;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

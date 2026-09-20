import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
const zenx = fileURLToPath(new URL("..", import.meta.url));
const artifact = path.join(
  zenx,
  ".packaged",
  "artifact",
  `ZenX-${process.platform}-${process.arch}`,
);
const binary =
  process.argv[2] ??
  (process.platform === "darwin"
    ? path.join(artifact, "ZenX.app", "Contents", "MacOS", "ZenX")
    : process.platform === "win32"
      ? path.join(
          artifact,
          "resources",
          "chrome-native-host",
          "zenx-native-host.cmd",
        )
      : path.join(artifact, "ZenX"));
const directory = await mkdtemp(path.join(tmpdir(), "zenx-native-host-smoke-"));
const origin = "chrome-extension://jenndkelhapgbokkmmfifkmiadkeflci/";
const token = randomBytes(32).toString("base64url");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
await mkdir(path.join(directory, "runtime"));
await writeFile(
  path.join(directory, "runtime/chrome-bridge.json"),
  JSON.stringify({
    protocolVersion: 1,
    nativeWebSocketUrl: `ws://127.0.0.1:${server.address().port}/native/${token}`,
  }),
);
const child = spawn(binary, [`--user-data-dir=${directory}`, origin], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
let stdout = Buffer.alloc(0),
  stderr = "",
  socket,
  received = [];
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const encode = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
const frames = [];
let stdoutFailure;
const failStdout = (reason) => {
  if (stdoutFailure !== undefined) return;
  const prefix = stdout.subarray(0, 16).toString("hex");
  stdoutFailure = new Error(
    `native stdout ${reason}; prefixHex=${prefix || "empty"}`,
  );
};
child.stdout.on("data", (chunk) => {
  if (stdoutFailure !== undefined) return;
  stdout = Buffer.concat([stdout, chunk]);
  try {
    while (stdout.length >= 4) {
      const length = stdout.readUInt32LE(0);
      if (length >= 1024 * 1024) {
        failStdout(`polluted or oversized length=${length}`);
        return;
      }
      if (stdout.length < 4 + length) break;
      try {
        frames.push(JSON.parse(stdout.subarray(4, 4 + length).toString()));
      } catch {
        failStdout(`contained invalid JSON length=${length}`);
        return;
      }
      stdout = stdout.subarray(4 + length);
    }
  } catch {
    failStdout("could not be decoded");
  }
});
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
try {
  const connected = new Promise((resolve, reject) => {
    server.once("connection", (ws, request) => {
      try {
        assert.equal(request.url, `/native/${token}`);
        assert.equal(request.headers.origin, origin);
        socket = ws;
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          received.push(message);
          if (message.type === "hello")
            ws.send(JSON.stringify({ type: "ready", protocolVersion: 1 }));
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  const connectionResult = await Promise.race([
    connected.then(() => true),
    exited.then(() => false),
  ]);
  assert(
    connectionResult,
    `native executable exited before connection: ${stderr}`,
  );
  const hello = encode({ type: "hello", protocolVersion: 1 });
  child.stdin.write(hello.subarray(0, 2));
  child.stdin.write(hello.subarray(2));
  const until = async (predicate) => {
    const end = Date.now() + 3000;
    while (!predicate()) {
      if (stdoutFailure !== undefined) throw stdoutFailure;
      assert(Date.now() < end, "frame timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await until(() => frames.length === 1);
  assert.deepEqual(frames[0], { type: "ready", protocolVersion: 1 });
  socket.send(
    JSON.stringify({
      type: "cdp-command",
      requestId: "probe",
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    }),
  );
  await until(() => frames.length === 2);
  assert.equal(frames[1].requestId, "probe");
  child.stdin.write(
    encode({
      type: "cdp-result",
      requestId: "probe",
      result: { result: { value: 2 } },
    }),
  );
  await until(() => received.length === 2);
  assert.equal(received[1].result.result.value, 2);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  if (stdoutFailure !== undefined) throw stdoutFailure;
  assert.equal(stdout.length, 0);
  console.log(
    JSON.stringify(
      {
        passed: true,
        binary,
        platform: process.platform,
        realExecutable: true,
        isolatedUserData: true,
        origin: true,
        fragmentedInput: true,
        helloReady: true,
        bidirectionalFraming: true,
        cleanStdout: true,
        exitCode: 0,
        stderrBytes: Buffer.byteLength(stderr),
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(deadline);
  child.kill();
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

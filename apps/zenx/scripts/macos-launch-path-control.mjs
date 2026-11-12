// Test-app-only independent control worker. It can terminate only its own process.
import { chmod, realpath } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { workerData } from "node:worker_threads";
import { nativeProcessIdentity } from "./macos-launch-path-cleanup.mjs";
import { publishOwnershipReceipt } from "./macos-launch-path-ownership.mjs";

const config = workerData.config;
const native = await nativeProcessIdentity(process.pid);
if (
  !native ||
  (await realpath(native.executable)) !== (await realpath(process.execPath)) ||
  !native.arguments.includes(`--zenx-launch-path-instance=${config.receiptId}`)
)
  throw new Error("Control worker could not verify its own launch identity");
const identity = {
  pid: process.pid,
  executable: process.execPath,
  start: native.start,
  bootId: randomUUID(),
  receiptId: config.receiptId,
  round: config.round,
};
const token = Buffer.from(config.controlToken);
let terminating = false;
const server = net.createServer((socket) => {
  let received = "";
  socket.setTimeout(2_000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (data) => {
    received += data.toString("utf8");
    if (received.length > 4096) return socket.destroy();
    const newline = received.indexOf("\n");
    if (newline < 0) return;
    socket.removeAllListeners("data");
    let request;
    try {
      request = JSON.parse(received.slice(0, newline));
    } catch {
      return socket.end('{"ok":false}\n');
    }
    const supplied = Buffer.from(
      typeof request.token === "string" ? request.token : "",
    );
    const authorized =
      supplied.length === token.length &&
      timingSafeEqual(supplied, token) &&
      request.pid === identity.pid &&
      request.bootId === identity.bootId &&
      request.executable === identity.executable &&
      request.start === identity.start &&
      request.receiptId === identity.receiptId &&
      ["inspect", "terminate"].includes(request.action);
    if (!authorized || terminating) return socket.end('{"ok":false}\n');
    socket.end(JSON.stringify({ ok: true, ...identity }) + "\n");
    if (request.action === "terminate") {
      terminating = true;
      // This PID cannot be recycled while this very process executes the call.
      // A hung Electron main loop does not prevent this separate worker running.
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 30);
    }
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.controlSocket, resolve);
});
await chmod(config.controlSocket, 0o600);
await publishOwnershipReceipt(config.ownershipFile, identity);

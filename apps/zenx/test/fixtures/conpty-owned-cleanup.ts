// Launched only by shell-pty-native-cleanup.test.ts on Windows. Each native child
// belongs to this fixture, and has its own fail-safe exit. No process-list scan.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { verifyShellPtyPatch } from "../../scripts/shell-pty-patch.mjs";
import { wrapDesktopPty } from "../../src/main/shell-pty.js";

const mode = process.argv[2];
assert(mode === "natural" || mode === "stop");
const require = createRequire(import.meta.url);
await verifyShellPtyPatch(
  path.dirname(require.resolve("node-pty/package.json")),
);
const { spawn } = await import("node-pty");
const raw = spawn(
  process.execPath,
  [
    "-e",
    mode === "natural"
      ? "console.log('OWNED_READY'); setTimeout(() => process.exit(0), 200)"
      : "console.log('OWNED_READY'); setTimeout(() => process.exit(91), 8000)",
  ],
  {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    useConpty: true,
    useConptyDll: false,
  },
);
const terminal = wrapDesktopPty(raw);
let output = "";
let exited = false;
const exit = new Promise<number>((resolve) =>
  terminal.onExit(({ exitCode }) => {
    exited = true;
    resolve(exitCode);
  }),
);
terminal.onData((data) => {
  output += data;
});
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(
      Date.now() < deadline,
      `PTY ${mode} observation timeout: ${JSON.stringify(output)}`,
    );
    await sleep(10);
  }
};
try {
  await until(() => output.includes("OWNED_READY"));
  if (mode === "stop") terminal.kill();
  await until(() => exited);
  const exitCode = await exit;
  if (mode === "natural") assert.equal(exitCode, 0);
  else
    assert.notEqual(
      exitCode,
      91,
      "Stop must precede the fixture fail-safe exit",
    );
  await until(() => {
    try {
      process.kill(raw.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  });
  console.log(JSON.stringify({ mode, exitCode, ownedPidGone: true }));
} finally {
  terminal.kill();
}
// Do not call process.exit: the parent requires actual event-loop settlement,
// including node-pty reader disposal, rather than a forced successful exit.

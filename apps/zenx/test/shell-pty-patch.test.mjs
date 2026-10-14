import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { prepareShellPty } from "../scripts/prepare-shell-pty.mjs";
import {
  applyShellPtyPatch,
  verifyShellPtyPatch,
  SHELL_PTY_PATCH,
} from "../scripts/shell-pty-patch.mjs";

const require = createRequire(import.meta.url);
const installed = await readFile(
  path.join(
    path.dirname(require.resolve("node-pty/package.json")),
    SHELL_PTY_PATCH.file,
  ),
  "utf8",
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
// Reconstruct the reviewed npm bytes when Windows postinstall already patched
// them. Full-file hashes below independently pin both fixture representations.
const originalBlock = `                this._getConsoleProcessList().then(function (consoleProcessList) {
                    consoleProcessList.forEach(function (pid) {
                        try {
                            process.kill(pid);
                        }
                        catch (e) {
                            // Ignore if process cannot be found (kill ESRCH error)
                        }
                    });
                });
`;
const patchedBlock =
  "                // ZenX: close only the owned ConPTY; never schedule a bare-PID sweep.\n";
const original =
  digest(installed) === SHELL_PTY_PATCH.patchedSha256
    ? installed.replace(patchedBlock, originalBlock)
    : installed;
assert.equal(digest(original), SHELL_PTY_PATCH.originalSha256);

async function fixture(t, source = original, version = "1.1.0") {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-pty-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "lib"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "node-pty", version }),
  );
  await writeFile(path.join(root, SHELL_PTY_PATCH.file), source);
  return root;
}

test("Windows install applies the exact audited patch idempotently", async (t) => {
  const root = await fixture(t);
  await assert.rejects(verifyShellPtyPatch(root), /missing or unrecognized/);
  await prepareShellPty(root, "win32");
  await verifyShellPtyPatch(root);
  const patched = await readFile(path.join(root, SHELL_PTY_PATCH.file), "utf8");
  assert.equal(digest(patched), SHELL_PTY_PATCH.patchedSha256);
  await prepareShellPty(root, "win32");
  assert.equal(
    await readFile(path.join(root, SHELL_PTY_PATCH.file), "utf8"),
    patched,
  );
});

test("unknown source and versions fail without modifying the package", async (t) => {
  for (const [source, version, reason] of [
    [
      original + "\n// unexpected bytes",
      "1.1.0",
      /Unrecognized node-pty source/,
    ],
    [original, "1.1.1", /Unaudited node-pty version/],
  ]) {
    const root = await fixture(t, source, version);
    await assert.rejects(applyShellPtyPatch(root), reason);
    await assert.rejects(verifyShellPtyPatch(root));
    assert.equal(
      await readFile(path.join(root, SHELL_PTY_PATCH.file), "utf8"),
      source,
    );
  }
});

test("POSIX preparation leaves Windows dependency code unchanged", async (t) => {
  const root = await fixture(t);
  await prepareShellPty(root, "linux");
  await prepareShellPty(root, "darwin");
  assert.equal(
    await readFile(path.join(root, SHELL_PTY_PATCH.file), "utf8"),
    original,
  );
});

function driver(source, exitCode) {
  // All native/process APIs are synthetic. Never spawn, attach to or kill a PID.
  const events = [];
  const timers = [];
  const helper = new EventEmitter();
  helper.kill = () => events.push("helper.kill");
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    __dirname: "/synthetic/node-pty/lib",
    require: (name) =>
      name === "path"
        ? path
        : name === "child_process"
          ? {
              fork: () => {
                events.push("helper.fork");
                return helper;
              },
            }
          : {},
    process: { kill: (pid) => events.push(`unverified.kill:${pid}`) },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
  });
  const agent = Object.assign(
    Object.create(exports.WindowsPtyAgent.prototype),
    {
      _useConpty: true,
      _useConptyDll: false,
      _exitCode: exitCode,
      _innerPid: 424242,
      _pty: 7,
      _inSocket: {},
      _outSocket: {},
      _ptyNative: {
        kill: (pty, dll) => events.push(`owned.native:${pty}:${dll}`),
      },
      _conoutSocketWorker: {
        dispose: () => events.push("owned.reader.dispose"),
      },
    },
  );
  return { agent, events, timers, helper };
}

test("synthetic upstream failure demonstrates delayed stale-PID path", async () => {
  const f = driver(original, 0);
  f.agent.kill();
  f.helper.emit("exit", 1);
  assert.equal(f.timers[0].ms, 5000);
  f.timers[0].fn();
  await Promise.resolve();
  assert.deepEqual(f.events, [
    "helper.fork",
    "owned.native:7:false",
    "owned.reader.dispose",
    "helper.kill",
    "unverified.kill:424242",
  ]);
});

test("patched natural exit and live Stop never enter PID discovery or delayed kill", async (t) => {
  const root = await fixture(t);
  await applyShellPtyPatch(root);
  const patched = await readFile(path.join(root, SHELL_PTY_PATCH.file), "utf8");
  for (const exitCode of [undefined, 0]) {
    const f = driver(patched, exitCode);
    f.agent.kill();
    await Promise.resolve();
    assert.deepEqual(f.events, [
      "owned.native:7:false",
      "owned.reader.dispose",
    ]);
    assert.equal(f.timers.length, 0);
    assert.equal(f.agent._inSocket.readable, false);
    assert.equal(f.agent._outSocket.readable, false);
  }
});

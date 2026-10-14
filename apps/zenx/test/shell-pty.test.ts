import assert from "node:assert/strict";
import test from "node:test";
import type { ShellPtyProcess } from "../../../src/shell-session.js";
import { wrapDesktopPty } from "../src/main/shell-pty.js";

function fixture() {
  const signals: (string | undefined)[] = [];
  let exit!: (event: { exitCode: number }) => void;
  const terminal: ShellPtyProcess = {
    write() {},
    resize() {},
    onData: () => ({ dispose() {} }),
    onExit(listener) {
      exit = listener;
      return { dispose() {} };
    },
    kill(signal) {
      signals.push(signal);
    },
  };
  return { terminal, signals, exit: () => exit({ exitCode: 0 }) };
}
test("Windows PTY cancellation is signal-free and disposes only once", () => {
  const f = fixture();
  const terminal = wrapDesktopPty(f.terminal, "win32");
  terminal.onExit(() => {});
  terminal.kill("SIGTERM");
  terminal.kill("SIGKILL");
  f.exit();
  assert.deepEqual(f.signals, [undefined]);
});
test("natural Windows shell exit releases the native reader worker via public cleanup", () => {
  const f = fixture();
  let observed = false;
  wrapDesktopPty(f.terminal, "win32").onExit(() => {
    observed = true;
  });
  f.exit();
  assert(observed);
  assert.deepEqual(f.signals, [undefined]);
});
test("POSIX PTY escalation keeps its signals and native exit remains authoritative", () => {
  const f = fixture();
  const terminal = wrapDesktopPty(f.terminal, "linux");
  terminal.onExit(() => {});
  terminal.kill("SIGTERM");
  terminal.kill("SIGKILL");
  f.exit();
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
});

test("observed Windows exit survives native cleanup failure with a warning", (t) => {
  const f = fixture();
  const failure = new Error("synthetic native cleanup failure");
  f.terminal.kill = () => {
    throw failure;
  };
  const warning = t.mock.method(process, "emitWarning", () => {});
  let observed: number | undefined;
  const terminal = wrapDesktopPty(f.terminal, "win32");
  terminal.onExit((event) => {
    observed = event.exitCode;
  });
  assert.doesNotThrow(f.exit);
  assert.equal(observed, 0);
  assert.equal(warning.mock.callCount(), 1);
  assert.match(
    String(warning.mock.calls[0]?.arguments[0]),
    /cleanup after shell exit failed/,
  );
  // A live-process Stop failure still propagates; it is never reported as success.
  assert.throws(() => terminal.kill("SIGTERM"), failure);
});

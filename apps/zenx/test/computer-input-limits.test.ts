import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputerZenXCapabilityPackage,
  boundComputerCapabilityManifest,
  computerCapabilityManifest,
  selectComputerWindows,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import {
  ComputerTargetSession,
  COMPUTER_NATIVE_KEY_CODES,
} from "../src/main/capabilities/computer-target-session.js";

const navigationKeys = ["delete", "home", "end", "pageUp", "pageDown"];
const functionKeys = Array.from({ length: 20 }, (_, index) => `f${index + 1}`);
const extendedKeys = [...navigationKeys, ...functionKeys];

test("window discovery does not hide matching targets behind an unpageable 32-window cap", () => {
  const targets = Array.from({ length: 80 }, (_, index) => ({
    pid: 100 + index,
    applicationName: "Owned fixture",
    windowTitle: `Document ${index}`,
  }));
  assert.equal(selectComputerWindows(targets).windows.length, 80);
  assert.equal(selectComputerWindows(targets).truncated, false);
  assert.equal(
    selectComputerWindows(targets, "document 79").windows[0]?.target.pid,
    179,
  );
  assert.equal(selectComputerWindows(targets, "no match").windows.length, 0);
});

test("native navigation and function keys reach the same exact selected binding as basic keys", async () => {
  const calls: Record<string, unknown>[] = [];
  const session = new ComputerTargetSession({
    async request(request) {
      calls.push(request);
      return request.operation === "select"
        ? {
            bindingId: "binding",
            appKeyboardInputAvailable: true,
            target: {
              pid: 7,
              applicationName: "Owned",
              windowTitle: "Fixture",
            },
            windowId: 10,
            bounds: { x: 0, y: 0, width: 100, height: 100 },
          }
        : {
            dispatch: "posted",
            applicationEffect: "unverified",
            release: "posted",
            targetScope: "application_current_focus",
          };
    },
    async close() {},
  });
  const unsupported = async (): Promise<never> => {
    throw Error("legacy route used");
  };
  const backend: ZenXComputerBackend = {
    targetSession: session,
    inspect: unsupported,
    press: unsupported,
    setValue: unsupported,
    screenshot: unsupported,
    foregroundClick: unsupported,
    foregroundKeyPress: unsupported,
    foregroundScroll: unsupported,
    close() {},
  };
  const capability = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
  );
  const signal = new AbortController().signal;
  const invoke = (name: string, arguments_: Record<string, unknown>) =>
    capability.invoke(name, {
      callId: "fixture",
      name,
      arguments: arguments_,
      cwd: "/",
      signal,
      threadId: "owner",
    });
  await invoke("computer_select_target", {
    target: { pid: 7, windowTitle: "Fixture" },
  });
  for (const key of extendedKeys) {
    await invoke("computer_foreground_key_press", {
      bindingId: "binding",
      key,
    });
    assert.equal(calls.at(-1)?.operation, "key");
    assert.equal(calls.at(-1)?.key, key);
    assert.equal(calls.at(-1)?.bindingId, "binding");
    await invoke("computer_foreground_shortcut", {
      bindingId: "binding",
      key,
      modifiers: ["shift"],
    });
    assert.equal(calls.at(-1)?.operation, "shortcut");
    await session.backgroundKeyPress("owner", "binding", key, signal);
    assert.equal(calls.at(-1)?.operation, "backgroundKeyPress");
  }
  for (const key of ["[", "]", "-", "=", ",", "/", "é"]) {
    await invoke("computer_foreground_shortcut", {
      bindingId: "binding",
      key,
      modifiers: ["command"],
    });
    assert.equal(calls.at(-1)?.key, key);
  }
  for (const key of ["ab", "\n", "\ud800", "command+a", "f21"]) {
    await assert.rejects(
      invoke("computer_foreground_shortcut", {
        bindingId: "binding",
        key,
        modifiers: ["command"],
      }),
      /Unsupported/,
    );
  }
  const count = calls.length;
  await assert.rejects(
    invoke("computer_foreground_key_press", {
      bindingId: "stale",
      key: "home",
    }),
    /binding|target changed/i,
  );
  await assert.rejects(
    invoke("computer_foreground_key_press", {
      bindingId: "binding",
      key: "f21",
    }),
    /Unsupported/,
  );
  assert.equal(calls.length, count);
  for (const name of [
    "computer_foreground_key_press",
    "computer_background_key_press",
  ]) {
    const tool = boundComputerCapabilityManifest.tools.find(
      (tool) => tool.name === name,
    )!;
    const keys = (
      tool.inputSchema.properties as Record<string, { enum: string[] }>
    ).key!.enum;
    for (const key of extendedKeys)
      assert.ok(keys.includes(key), `${name}: ${key}`);
  }
  const legacy = computerCapabilityManifest.tools.find(
    (tool) => tool.name === "computer_foreground_key_press",
  )!;
  assert.ok(
    !(
      legacy.inputSchema.properties as Record<string, { enum: string[] }>
    ).key!.enum.includes("f1"),
    "uncertified providers keep their own advertised vocabulary",
  );
});

test("model discovery preserves exact empty window titles rather than rejecting an entire desktop", async () => {
  const { ModelReferenceRegistry } =
    await import("../../../src/model-references.js");
  const { decodeComputerArguments, projectComputerResult } =
    await import("../src/main/capabilities/model-computer-facade.js");
  const refs = new ModelReferenceRegistry().scope("owner");
  const target = { pid: 7, windowTitle: "" };
  const projected = projectComputerResult(
    { windows: [{ target, applicationName: "Owned" }] },
    {},
    refs,
    "epoch",
  );
  const window = (
    projected.windows as Array<{ ref: string; windowTitle: string }>
  )[0]!;
  assert.equal(window.windowTitle, "");
  assert.deepEqual(
    decodeComputerArguments(
      "computer_inspect",
      { target: window.ref },
      refs,
      "epoch",
    ),
    { target, full: true },
  );
  assert.throws(
    () =>
      projectComputerResult(
        { windows: [{ target: { pid: 7 } }] },
        {},
        refs,
        "epoch",
      ),
    /exact window title/,
  );
});

test("bound helper exposes the same native keycodes as the advertised schema", async () => {
  const { MAC_BOUND_TARGET_SOURCE } =
    await import("../src/main/capabilities/computer-provider.js");
  const expected = {
    delete: 117,
    home: 115,
    end: 119,
    pageUp: 116,
    pageDown: 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
    f13: 105,
    f14: 107,
    f15: 113,
    f16: 106,
    f17: 64,
    f18: 79,
    f19: 80,
    f20: 90,
  };
  const table = /let keyCodes: \[String: CGKeyCode\] = \[([^\]]+)\]/.exec(
    MAC_BOUND_TARGET_SOURCE,
  )![1]!;
  const codes = Object.fromEntries(
    [...table.matchAll(/"([^"]+)":\s*(\d+)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  for (const [key, code] of Object.entries(expected))
    assert.equal(codes[key], code, key);
  assert.deepEqual(codes, COMPUTER_NATIVE_KEY_CODES);
});

// The current native layout resolver decides whether a printable logical key has
// one exact mapping. The Host must not reject common punctuation first.
test("shortcut schema does not hide printable punctuation behind an alphanumeric enum", () => {
  const tool = boundComputerCapabilityManifest.tools.find(
    (tool) => tool.name === "computer_foreground_shortcut",
  )!;
  const key = (
    tool.inputSchema.properties as Record<string, { anyOf?: unknown[] }>
  ).key!;
  assert.ok(
    key.anyOf,
    "shortcuts must admit printable characters beyond the named-key enum",
  );
});

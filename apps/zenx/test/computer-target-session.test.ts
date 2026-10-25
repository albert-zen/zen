import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputerTargetSession,
  type TargetTransport,
} from "../src/main/capabilities/computer-target-session.js";
const signal = new AbortController().signal;
function fixture() {
  const calls: Record<string, unknown>[] = [];
  let serial = 0;
  const transport: TargetTransport = {
    async request(request) {
      calls.push(request);
      if (request.operation === "select")
        return {
          bindingId: `b${++serial}`,
          target: { pid: 7, applicationName: "Fixture", windowTitle: "Window" },
          windowId: 17,
          bounds: { x: -100, y: 20, width: 400, height: 200 },
        };
      return {};
    },
    async close() {},
  };
  return { session: new ComputerTargetSession(transport), transport, calls };
}
test("explicit selection and capture share owner target, keyboard needs no image per key", async () => {
  const { session, calls } = fixture();
  await session.select("a", { pid: 7 }, signal);
  await session.input("a", { operation: "key", key: "enter" }, signal);
  await session.input("a", { operation: "key", key: "tab" }, signal);
  assert.equal(calls.length, 3);
  await assert.rejects(
    session.input("b", { operation: "key", key: "enter" }, signal),
    /Select a Computer target/,
  );
});
test("capture coordinates map to original window and reject stale/foreign capture", async () => {
  const { session, calls } = fixture();
  const image = await session.capture(
    "a",
    { pid: 7, windowTitle: "Window" },
    signal,
    async () => ({ width: 800, height: 400 }),
  );
  await session.input(
    "a",
    {
      operation: "click",
      x: 200,
      y: 100,
      button: "left",
      captureId: image.captureId,
    },
    signal,
  );
  assert.equal(calls.at(-1)?.x, 0);
  assert.equal(calls.at(-1)?.y, 70);
  await session.select("a", { pid: 8 }, signal);
  await assert.rejects(
    session.input(
      "a",
      {
        operation: "click",
        x: 0,
        y: 0,
        button: "left",
        captureId: image.captureId,
      },
      signal,
    ),
    /current window screenshot/,
  );
});
test("native refusal/unknown effect invalidates selection and never replays input", async () => {
  const { session, transport } = fixture();
  await session.select("a", { pid: 7 }, signal);
  let posts = 0;
  transport.request = async () => {
    posts++;
    throw new Error("partially dispatched; outcome unknown");
  };
  await assert.rejects(
    session.input("a", { operation: "key", key: "enter" }, signal),
    /outcome unknown/,
  );
  await assert.rejects(
    session.input("a", { operation: "key", key: "enter" }, signal),
    /Select a Computer target/,
  );
  assert.equal(posts, 1);
});

test("capture rejects movement during acquisition and incoherent image geometry", async () => {
  const { session, transport } = fixture();
  const original = transport.request;
  transport.request = async (...args) => {
    if (args[0].operation === "verify")
      throw new Error("Window geometry changed");
    return original(...args);
  };
  await assert.rejects(
    session.capture("a", { pid: 7 }, signal, async () => ({
      width: 800,
      height: 400,
    })),
    /geometry changed/,
  );
  transport.request = original;
  await assert.rejects(
    session.capture("a", { pid: 7 }, signal, async () => ({
      width: 800,
      height: 600,
    })),
    /not coherent/,
  );
});

test("unbound package calls never fall back to global input and consent still gates bound input", async () => {
  const { ComputerZenXCapabilityPackage } =
    await import("../src/main/capabilities/computer-provider.js");
  const { session, calls } = fixture();
  const unsupported = async (): Promise<never> => {
    throw new Error("Legacy backend must not be used");
  };
  const backend = {
    targetSession: session,
    inspect: unsupported,
    press: unsupported,
    setValue: unsupported,
    screenshot: unsupported,
    foregroundClick: unsupported,
    foregroundKeyPress: unsupported,
    foregroundScroll: unsupported,
    close: async () => {},
  };
  const capability = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
  );
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    owner: string | undefined = "thread",
  ) =>
    capability.invoke(name, {
      callId: "call",
      name,
      arguments: args,
      cwd: "/",
      signal,
      threadId: owner,
    });
  await invoke("computer_select_target", { target: { pid: 7 } });
  await invoke("computer_foreground_key_press", { key: "enter" });
  assert.equal(calls.at(-1)?.owner, "thread");
  capability.setForegroundControlAllowed(false);
  const count = calls.length;
  await assert.rejects(
    invoke("computer_foreground_key_press", { key: "enter" }),
    /enable Foreground computer control/,
  );
  assert.equal(calls.length, count);
  await assert.rejects(
    capability.invoke("computer_select_target", {
      callId: "call",
      name: "computer_select_target",
      arguments: { target: { pid: 7 } },
      cwd: "/",
      signal,
    }),
    /host-owned threadId/,
  );
  await capability.close();
});

test("packaged native profile advertises the actual bound runtime contract, other variants do not", async () => {
  const { readFile } = await import("node:fs/promises");
  const { boundComputerCapabilityManifest, computerCapabilityManifest } =
    await import("../src/main/capabilities/computer-provider.js");
  const profile = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-computer-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(profile.version, boundComputerCapabilityManifest.version);
  assert.equal(
    profile.mainDocument,
    boundComputerCapabilityManifest.mainDocument,
  );
  assert.deepEqual(profile.tools, boundComputerCapabilityManifest.tools);
  assert.ok(
    profile.tools.some(
      (tool: { name: string }) => tool.name === "computer_select_target",
    ),
  );
  assert.equal(
    computerCapabilityManifest.tools.some(
      (tool) => tool.name === "computer_select_target",
    ),
    false,
  );
});

test("input waiting for foreground takeover cannot silently follow a later selection", async () => {
  const { session, calls } = fixture();
  const a = await session.select("a", { pid: 7 }, signal);
  await session.select("a", { pid: 8 }, signal);
  const count = calls.length;
  await assert.rejects(
    session.input(
      "a",
      { operation: "key", key: "enter" },
      signal,
      undefined,
      a.bindingId,
    ),
    /target changed while input awaited/,
  );
  assert.equal(calls.length, count);
});

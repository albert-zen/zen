import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputerTargetSession,
  type TargetTransport,
} from "../src/main/capabilities/computer-target-session.js";
const signal = new AbortController().signal;

test("session availability changes retire selected windows and cannot publish an in-flight old selection", async () => {
  const { session, transport, calls } = fixture();
  await session.select("owner", { pid: 7 }, signal);
  session.invalidateSelections();
  await assert.rejects(
    session.input("owner", { operation: "key", key: "enter" }, signal),
    /Select a Computer target/,
  );
  assert.equal(calls.length, 1, "no input may use the retired selection");
  let complete!: (value: unknown) => void;
  transport.request = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const pending = session.select("owner", { pid: 7 }, signal);
  session.invalidateSelections();
  complete({
    bindingId: "old",
    target: { pid: 7, applicationName: "Fixture", windowTitle: "Window" },
    windowId: 17,
    bounds: { x: 0, y: 0, width: 400, height: 200 },
  });
  await assert.rejects(pending, /changed|retired/);
});
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
      return { dispatch: "posted", applicationEffect: "unverified" };
    },
    async close() {},
  };
  return { session: new ComputerTargetSession(transport), transport, calls };
}
test("pointer exemptions come only from the trusted foreground presenter argument", async () => {
  const { session, calls } = fixture();
  const selected = await session.select("a", { pid: 7 }, signal);
  const action = {
    operation: "scroll" as const,
    deltaY: 1,
    pointerPassthroughWindowIds: [999],
  };
  await session.input("a", action, signal, undefined, selected.bindingId);
  assert.deepEqual(calls.at(-1)?.pointerPassthroughWindowIds, []);
  await session.input("a", action, signal, undefined, selected.bindingId, [19]);
  assert.deepEqual(calls.at(-1)?.pointerPassthroughWindowIds, [19]);
});
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
      arguments: name.startsWith("computer_foreground_")
        ? { bindingId: "b1", ...args }
        : args,
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

test("native text and shortcuts share owner/consent fences and never echo typed text", async () => {
  const { ComputerZenXCapabilityPackage } =
    await import("../src/main/capabilities/computer-provider.js");
  const { session, calls } = fixture();
  const unsupported = async (): Promise<never> => {
    throw new Error("Legacy backend must not be used");
  };
  const capability = new ComputerZenXCapabilityPackage(
    {
      targetSession: session,
      inspect: unsupported,
      press: unsupported,
      setValue: unsupported,
      screenshot: unsupported,
      foregroundClick: unsupported,
      foregroundKeyPress: unsupported,
      foregroundScroll: unsupported,
      close: async () => {},
    },
    undefined,
    true,
  );
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    threadId = "a",
  ) =>
    capability.invoke(name, {
      callId: "call",
      name,
      arguments: name.startsWith("computer_foreground_")
        ? { bindingId: "b1", ...args }
        : args,
      cwd: "/",
      signal,
      threadId,
    });
  await invoke("computer_select_target", { target: { pid: 7 } });
  const text = "private 😀";
  const receipt = (await invoke("computer_foreground_type", { text })) as {
    characterCount: number;
  };
  assert.equal(receipt.characterCount, 9);
  assert.doesNotMatch(JSON.stringify(receipt), /private/);
  assert.equal(calls.at(-1)?.owner, "a");
  assert.equal(calls.at(-1)?.text, text);
  await invoke("computer_foreground_shortcut", {
    key: "a",
    modifiers: ["command"],
  });
  assert.equal(calls.at(-1)?.operation, "shortcut");
  const count = calls.length;
  await assert.rejects(
    invoke("computer_foreground_type", {
      text,
      bindingId: "stale-approved-target",
    }),
    /bindingId no longer matches/,
  );
  await assert.rejects(
    invoke("computer_foreground_type", { text: "x".repeat(1025) }),
    /1024/,
  );
  await assert.rejects(
    invoke("computer_foreground_type", { text: "\ud800" }),
    /well-formed/,
  );
  await assert.rejects(
    invoke("computer_foreground_shortcut", {
      key: "a",
      modifiers: ["command", "command"],
    }),
    /Unsupported shortcut/,
  );
  await assert.rejects(
    invoke(
      "computer_foreground_shortcut",
      { key: "a", modifiers: ["command"] },
      "other",
    ),
    /Select a Computer target/,
  );
  assert.equal(calls.length, count);
  const awaitingApproval = { key: "enter", bindingId: "b1" };
  await invoke("computer_select_target", { target: { pid: 8 } });
  const afterSelection = calls.length;
  await assert.rejects(
    invoke("computer_foreground_key_press", awaitingApproval),
    /bindingId no longer matches/,
  );
  assert.equal(calls.length, afterSelection);
  assert.equal(session.selectedBindingId("a"), "b2");
  await invoke("computer_foreground_shortcut", {
    key: "a",
    modifiers: ["command"],
    bindingId: "b2",
  });
  capability.setForegroundControlAllowed(false);
  await assert.rejects(
    invoke("computer_foreground_type", { text }),
    /enable Foreground/,
  );
  await capability.close();
});

const ocrTarget = { pid: 7, windowTitle: "Window" };
const ocrImage = () => ({
  width: 800,
  height: 400,
  artifactPath: "/synthetic/never-read.png",
  capturedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

test("OCR reads exactly the original capture with native checks and 2x image coordinates", async () => {
  const { session, calls } = fixture();
  const pixels = ocrImage();
  const capture = await session.capture(
    "a",
    ocrTarget,
    signal,
    async () => pixels,
  );
  const before = calls.length;
  const read = await session.readCapture(
    "a",
    ocrTarget,
    capture.captureId,
    signal,
    async (image, binding) => {
      assert.equal(image.capturedAt, pixels.capturedAt);
      assert.equal(image.width / binding.bounds.width, 2);
      return { text: "工作消息", x: 200, y: 100 };
    },
  );
  assert.equal(read.text, "工作消息");
  assert.deepEqual(
    calls.slice(before).map((call) => call.operation),
    ["verify", "verify"],
  );
  await session.input(
    "a",
    {
      operation: "click",
      captureId: capture.captureId,
      x: read.x,
      y: read.y,
      button: "left",
    },
    signal,
  );
  assert.equal(calls.at(-1)?.x, 0); // -100 + 200 / 2
  assert.equal(calls.at(-1)?.y, 70); // 20 + 100 / 2
  await assert.rejects(
    session.readCapture(
      "a",
      ocrTarget,
      capture.captureId,
      signal,
      async () => "stale",
    ),
    /current, unexpired screenshot/,
  );
});

test("OCR rejects foreign owner/target/capture and expired pixels without native work", async () => {
  const { session, calls } = fixture();
  const capture = await session.capture("a", ocrTarget, signal, async () =>
    ocrImage(),
  );
  const before = calls.length;
  let reads = 0;
  const read = async () => {
    reads++;
  };
  for (const [owner, target, id] of [
    ["b", ocrTarget, capture.captureId],
    ["a", { ...ocrTarget, windowTitle: "Other" }, capture.captureId],
    ["a", ocrTarget, "other-capture"],
  ] as const)
    await assert.rejects(
      session.readCapture(owner, target, id, signal, read),
      /current, unexpired screenshot/,
    );
  assert.equal(calls.length, before);
  assert.equal(reads, 0);
  for (const expiresAt of [new Date(0).toISOString(), "invalid"]) {
    const expired = await session.capture("a", ocrTarget, signal, async () => ({
      ...ocrImage(),
      expiresAt,
    }));
    await assert.rejects(
      session.readCapture("a", ocrTarget, expired.captureId, signal, read),
      /current, unexpired screenshot/,
    );
  }
  assert.equal(reads, 0);
});

test("OCR discards late results after cancellation, replacement, mutation or geometry failure without retry", async () => {
  for (const change of ["cancel", "replace", "mutate", "geometry"] as const) {
    const { session, transport, calls } = fixture();
    const controller = new AbortController();
    const capture = await session.capture("a", ocrTarget, signal, async () =>
      ocrImage(),
    );
    let reads = 0;
    const original = transport.request;
    await assert.rejects(
      session.readCapture(
        "a",
        ocrTarget,
        capture.captureId,
        controller.signal,
        async () => {
          reads++;
          if (change === "cancel") controller.abort();
          if (change === "replace")
            await session.capture("a", ocrTarget, signal, async () =>
              ocrImage(),
            );
          if (change === "mutate") session.invalidateCaptures();
          if (change === "geometry")
            transport.request = async (request, ...rest) => {
              if (request.operation === "verify")
                throw Error("Window geometry changed");
              return original(request, ...rest);
            };
          return "late OCR text";
        },
      ),
      /abort|current, unexpired screenshot|geometry changed/iu,
    );
    assert.equal(reads, 1);
    assert.ok(
      calls.every((call) =>
        ["select", "verify"].includes(String(call.operation)),
      ),
    );
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

for (const receipt of [
  undefined,
  null,
  {},
  { dispatch: "completed" },
  { dispatch: "posted", applicationEffect: "verified" },
]) {
  test(`invalid input receipt ${JSON.stringify(receipt)} stays unknown and cannot be replayed`, async () => {
    const { session, transport } = fixture();
    await session.select("a", { pid: 7 }, signal);
    let calls = 0;
    transport.request = async () => {
      calls++;
      return receipt;
    };
    await assert.rejects(
      session.input("a", { operation: "key", key: "enter" }, signal),
      /outcome unknown; do not retry automatically/,
    );
    await assert.rejects(
      session.input("a", { operation: "key", key: "enter" }, signal),
      /Select a Computer target/,
    );
    assert.equal(calls, 1);
  });
}

test("late selection after close cannot restore an input binding or start another request", async () => {
  const { session, transport } = fixture();
  const original = transport.request;
  const reply = deferred<unknown>();
  let calls = 0;
  transport.request = async () => {
    calls++;
    return reply.promise;
  };
  const select = session.select("a", { pid: 7 }, signal);
  const rejected = assert.rejects(select, /session is closed/);
  await session.close();
  reply.resolve(await original({ operation: "select" }, signal));
  await rejected;
  assert.throws(
    () => session.selectedBindingId("a"),
    /Select a Computer target/,
  );
  await assert.rejects(
    session.select("a", { pid: 7 }, signal),
    /session is closed/,
  );
  assert.equal(calls, 1);
});

for (const change of [
  "close",
  "select",
  "abort",
  "input",
  "invalidate",
] as const) {
  test(`capture ${change} race publishes no stale coordinates or later verification`, async () => {
    const { session, calls } = fixture();
    const image = deferred<{ width: number; height: number }>();
    const entered = deferred<void>();
    const controller = new AbortController();
    const capture = session.capture(
      "a",
      { pid: 7 },
      controller.signal,
      async () => {
        entered.resolve();
        return image.promise;
      },
    );
    const rejected = assert.rejects(capture, /target changed|abort/iu);
    await entered.promise;
    let newBinding: string | undefined;
    if (change === "close") await session.close();
    if (change === "select")
      newBinding = (await session.select("a", { pid: 8 }, signal)).bindingId;
    if (change === "abort") controller.abort();
    if (change === "input")
      await session.input("a", { operation: "key", key: "enter" }, signal);
    if (change === "invalidate") session.invalidateCaptures();
    const before = calls.length;
    image.resolve({ width: 800, height: 400 });
    await rejected;
    assert.equal(
      calls.length,
      before,
      "retired capture must not queue native reads",
    );
    if (newBinding) assert.equal(session.selectedBindingId("a"), newBinding);
  });
}

test("late failed input does not clear a newer explicit selection", async () => {
  const { session, transport } = fixture();
  await session.select("a", { pid: 7 }, signal);
  const reply = deferred<unknown>();
  const original = transport.request;
  transport.request = async (...args) =>
    args[0].operation === "key" ? reply.promise : original(...args);
  const input = session.input("a", { operation: "key", key: "enter" }, signal);
  const rejected = assert.rejects(input, /outcome unknown/);
  const next = await session.select("a", { pid: 8 }, signal);
  reply.resolve({});
  await rejected;
  assert.equal(session.selectedBindingId("a"), next.bindingId);
});

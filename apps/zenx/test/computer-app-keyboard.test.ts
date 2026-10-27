import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputerTargetSession,
  type TargetTransport,
} from "../src/main/capabilities/computer-target-session.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import {
  decodeComputerArguments,
  projectComputerResult,
} from "../src/main/capabilities/model-computer-facade.js";
import {
  ComputerZenXCapabilityPackage,
  boundComputerCapabilityManifest,
  selectComputerWindows,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import {
  ComputerThreadObservation,
  type ComputerThreadEvent,
} from "../src/main/capabilities/computer-thread-observation.js";
function fixture(cap = true) {
  const calls: Record<string, unknown>[] = [];
  const transport: TargetTransport = {
    async request(request) {
      calls.push(request);
      return request.operation === "select"
        ? {
            bindingId: "owned",
            ...(cap ? { appKeyboardInputAvailable: true } : {}),
            target: {
              pid: 7,
              bundleId: "owned.test",
              applicationName: "Owned",
              windowTitle: "Original window",
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
  };
  return { calls, session: new ComputerTargetSession(transport) };
}
const signal = new AbortController().signal;
test("app keyboard derives one owner binding without capture or window verification", async () => {
  const { calls, session } = fixture();
  await session.select("owner", { pid: 7 }, signal);
  await session.backgroundType("owner", "owned", "中文🌙🦆", signal);
  await session.backgroundKeyPress("owner", "owned", "enter", signal);
  assert.deepEqual(
    calls.map((c) => c.operation),
    ["select", "backgroundType", "backgroundKeyPress"],
  );
  assert.equal(calls[1]?.bindingId, "owned");
  assert.equal(calls[1]?.target, undefined);
  await assert.rejects(
    session.backgroundType("foreign", "owned", "x", signal),
    /binding|Select/i,
  );
  await assert.rejects(
    session.backgroundType("owner", "reselected", "x", signal),
    /binding|changed/i,
  );
});
test("old helper, malformed Unicode and shortcuts reject before native dispatch", async () => {
  const old = fixture(false);
  await old.session.select("owner", { pid: 7 }, signal);
  await assert.rejects(
    old.session.backgroundType("owner", "owned", "x", signal),
    /helper|keyboard/i,
  );
  assert.equal(old.calls.length, 1);
  const f = fixture();
  await f.session.select("owner", { pid: 7 }, signal);
  for (const text of ["", "x".repeat(1025), "\ud800"])
    await assert.rejects(
      f.session.backgroundType("owner", "owned", text, signal),
      /Unicode|text/i,
    );
  await assert.rejects(
    f.session.backgroundKeyPress("owner", "owned", "command+a", signal),
    /key/i,
  );
  assert.equal(f.calls.length, 1);
  await f.session.backgroundType("owner", "owned", "🦆".repeat(1024), signal);
});
test("model app input consumes only an existing typed binding ref, never raw routing", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const projected = projectComputerResult(
    { bindingId: "owned" },
    {},
    refs,
    "epoch",
  );
  assert.deepEqual(
    decodeComputerArguments(
      "computer_background_type",
      { binding: projected.binding, text: "中文🌙" },
      refs,
      "epoch",
    ),
    { bindingId: "owned", text: "中文🌙" },
  );
  for (const extra of [
    { pid: 7 },
    { target: {} },
    { capture: projected.binding },
    { modifiers: ["command"] },
  ])
    assert.throws(
      () =>
        decodeComputerArguments(
          "computer_background_type",
          { binding: projected.binding, text: "x", ...extra },
          refs,
          "epoch",
        ),
      /only|accept|binding/i,
    );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_background_type",
        { binding: projected.binding, text: "x" },
        refs,
        "retired",
      ),
    /retired|reference/i,
  );
});

test("locked Host package uses app lease and independent permission without foreground consent", async () => {
  const f = fixture();
  const accesses: unknown[] = [];
  const backend = {
    targetSession: f.session,
    nativeAppKeyboard: true,
    nativeTargetedAccessibility: true,
    async listWindows(query?: string) {
      // Synthetic native discovery output, passed through the actual Host's
      // bounded projection. The independent CG discovery fixture covers UID/AX.
      return selectComputerWindows(
        [
          {
            pid: 7,
            applicationName: "Owned",
            bundleId: "owned.test",
            windowTitle: "Original window",
          },
        ],
        query,
      );
    },
  } as unknown as ZenXComputerBackend;
  const service = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    false,
    undefined,
    {
      snapshot: () => ({
        platform: "darwin",
        sessionState: "locked",
        revision: 1,
        displayState: "unknown",
        lockedUse: "provider-dependent",
        keepAwake: "inactive",
      }),
      onInvalidated: () => () => {},
      acquire: (signal, access) => {
        accesses.push(access);
        return { signal, revision: 1, release() {} };
      },
    },
  );
  const refs = new ModelReferenceRegistry().scope("owner");
  const invoke = (name: string, arguments_: Record<string, unknown>) =>
    service.invoke(name, {
      threadId: "owner",
      callId: name,
      arguments: arguments_,
      signal,
      cwd: "/synthetic",
    } as never);
  const listed = projectComputerResult(
    (await invoke("computer_list_windows", { query: "Owned" })) as Record<
      string,
      unknown
    >,
    {},
    refs,
    "epoch",
  );
  const windowRef = (listed.windows as Array<{ ref: string }>)[0]!.ref;
  const selectArgs = decodeComputerArguments(
    "computer_select_target",
    { target: windowRef },
    refs,
    "epoch",
  );
  const selected = projectComputerResult(
    (await invoke("computer_select_target", selectArgs)) as Record<
      string,
      unknown
    >,
    selectArgs,
    refs,
    "epoch",
  );
  const appArgs = decodeComputerArguments(
    "computer_background_type",
    { binding: selected.binding, text: "中文🌙" },
    refs,
    "epoch",
  );
  const result = (await service.invoke("computer_background_type", {
    threadId: "owner",
    callId: "call",
    arguments: appArgs,
    signal,
    cwd: "/synthetic",
  } as never)) as Record<string, unknown>;
  assert.equal(result.targetScope, "application_current_focus");
  assert.deepEqual(accesses, [
    "native-targeted-accessibility",
    "native-targeted-accessibility",
    "native-targeted-app",
  ]);
  for (const name of [
    "computer_background_type",
    "computer_background_key_press",
  ]) {
    const tool = boundComputerCapabilityManifest.tools.find(
      (t) => t.name === name,
    )!;
    assert.deepEqual(tool.permissions, ["computer.app.background_keyboard"]);
    assert.equal(tool.interactionMode, "background_safe");
  }
});

test("application activity has no old-window pointer, live capture or fresh-frame authority", () => {
  let captures = 0;
  const projection = new ComputerThreadObservation({
    observeWindow() {
      captures++;
      return () => {};
    },
  } as unknown as ZenXComputerBackend);
  const events: ComputerThreadEvent[] = [];
  projection.observe({ threadId: "owner", frames: true }, (e) =>
    events.push(e),
  );
  const done = projection.startActivity(
    "owner",
    "key-call",
    { pid: 7, applicationName: "Owned" },
    "background-app",
  );
  const targets = events.findLast((e) => e.type === "targets")!;
  assert.equal(targets.type, "targets");
  assert.equal(targets.targets[0]?.activity?.kind, "background-app");
  assert.equal(targets.targets[0]?.target.windowTitle, undefined);
  assert.equal(targets.targets[0]?.pointer, undefined);
  assert.equal(captures, 0);
  done();
  projection.close();
});

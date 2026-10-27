import assert from "node:assert/strict";
import test from "node:test";
import { ComputerZenXCapabilityPackage } from "../src/main/capabilities/computer-provider.js";
import {
  WinAppStrictUiaComputerBackend,
  windowsStrictUiaCapabilityManifest,
  StrictUiaOperationError,
} from "../src/main/capabilities/windows-strict-uia-provider.js";
import type { WinAppCliRunOptions } from "../src/main/capabilities/windows-computer-provider.js";
import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";
import {
  validateStrictUiaControl,
  validateStrictUiaRoot,
} from "../src/main/capabilities/windows-strict-uia-contract.js";

const root = {
  hwnd: "100",
  pid: 71,
  processStartTimeTicks: "638000000000000000",
  className: "Window",
  runtimeId: [42, 100],
};
const control = {
  hwnd: "101",
  pid: 71,
  nativeClassName: "EDIT",
  runtimeId: [42, 101],
  name: "Editor",
  automationId: "edit",
  className: "EDIT",
  frameworkId: "Win32",
  controlType: 50004,
  bounds: { left: 1, top: 2, width: 100, height: 20 },
  enabled: true,
  offscreen: false,
  password: false,
  invokePattern: true,
  valuePattern: true,
  valueReadOnly: false,
};
const identity = {
  schemaVersion: 1,
  contractVersion: 1,
  providerBuild: "zenx-winapp-0.3.1-af0.2",
  upstreamCommit: "c8ada4a403c43b96780b87abc454cba51f649c60",
  autoSetFocus: false,
};
const target = { pid: 71, windowTitle: "Target" };
test("strict manifest declares only permissions actually used by its background tools", () => {
  const declared = windowsStrictUiaCapabilityManifest.permissions.map(
    (permission) => permission.id,
  );
  const used = windowsStrictUiaCapabilityManifest.tools.flatMap(
    (tool) => tool.permissions,
  );
  assert.equal(declared.includes("computer.foreground.control"), false);
  assert.deepEqual([...new Set(declared)].sort(), [...new Set(used)].sort());
  assert.ok(
    windowsStrictUiaCapabilityManifest.tools.every(
      (tool) => tool.interactionMode === "background_safe",
    ),
  );
});
function fixture(
  action?: (
    request: Record<string, unknown>,
    options: WinAppCliRunOptions,
  ) => unknown,
  inspectionReply?: () => unknown,
) {
  let controls = [control];
  const requests: Record<string, unknown>[] = [];
  let bindings = 0;
  const backend = new WinAppStrictUiaComputerBackend({
    command: "/packaged/winapp.exe",
    platform: "win32",
    bindBeforeSpawn: async () => {
      bindings++;
      return async () => undefined;
    },
    runner: {
      async run(_exe, args, options) {
        await options.bindBeforeSpawn?.();
        options.signal?.throwIfAborted();
        if (args[0] === "--zenx-uia-contract")
          return { stdout: JSON.stringify(identity), stderr: "" };
        if (args[0] === "ui")
          return {
            stdout: JSON.stringify([
              {
                hwnd: "100",
                processId: 71,
                processName: "fixture",
                title: "Target",
                width: 640,
                height: 400,
              },
            ]),
            stderr: "",
          };
        const request = JSON.parse(options.stdin!);
        requests.push(request);
        options.onSpawn?.(123);
        const reply =
          request.operation === "inspect"
            ? (inspectionReply?.() ?? { root, controls })
            : (action?.(request, options) ??
              (request.operation === "set_value"
                ? { value: request.value }
                : {}));
        return {
          stdout: JSON.stringify({
            ...identity,
            operation: request.operation,
            outcome: "completed",
            error: null,
            ...reply,
          }),
          stderr: "",
        };
      },
    },
  });
  return {
    backend,
    requests,
    setControls: (value: typeof controls) => {
      controls = value;
    },
    get bindings() {
      return bindings;
    },
  };
}
test("verified strict route performs one Unicode mutation without foreground permission", async () => {
  const f = fixture();
  const computer = new ComputerZenXCapabilityPackage(
    f.backend,
    windowsStrictUiaCapabilityManifest,
  );
  try {
    const inspected = await f.backend.inspect(target);
    const value = '中文 😀 "quoted" \\';
    const receipt = await computer.invoke("computer_set_value", {
      name: "computer_set_value",
      arguments: { target, control: inspected.controls[0]!.selector, value },
      cwd: process.cwd(),
      callId: "strict-value",
      signal: new AbortController().signal,
    });
    assert.equal(
      (receipt as { characterCount: number }).characterCount,
      value.length,
    );
    assert.deepEqual((receipt as { valueReadback: unknown }).valueReadback, {
      matchesRequested: true,
      source: "native_value_pattern",
    });
    assert.equal(JSON.stringify(receipt).includes(value), false);
    assert.equal(
      f.requests.filter((r) => r.operation === "set_value").length,
      1,
    );
    assert.deepEqual(f.requests.at(-1)?.root, root);
    assert.deepEqual(f.requests.at(-1)?.control, control);
    assert.ok(f.bindings >= 3);
    await assert.rejects(
      f.backend.press(target, inspected.controls[0]!.selector),
      /stale/iu,
    );
  } finally {
    await computer.close();
  }
});
test("strict observation refuses virtual, password, and duplicate native controls without dispatch", async () => {
  for (const controls of [
    [{ ...control, hwnd: "0" }],
    [{ ...control, password: true }],
    [control, { ...control, name: "Duplicate" }],
  ]) {
    const f = fixture();
    f.setControls(controls);
    try {
      const inspection = await f.backend.inspect(target);
      assert.deepEqual(inspection.controls[0]?.actions, []);
      await assert.rejects(
        f.backend.press(target, inspection.controls[0]!.selector),
        /supports|unsupported/iu,
      );
      assert.equal(f.requests.length, 1);
    } finally {
      await f.backend.close();
    }
  }
});
test("anonymous virtual controls remain read-only rows without capture identity", async () => {
  const f = fixture();
  f.setControls([
    { ...control, hwnd: "0", runtimeId: [], name: "Anonymous virtual" },
    control,
  ]);
  try {
    const inspection = await f.backend.inspect(target);
    const anonymous = inspection.controls.find(
      (entry) => entry.title === "Anonymous virtual",
    )!;
    assert.ok(anonymous);
    assert.deepEqual(anonymous.actions, []);
    const capture = inspection[OBSERVATION_CAPTURE]!;
    assert.equal(capture.coverage.sourceComplete, true);
    assert.equal(capture.entries.length, 2);
    assert.equal(
      capture.entries.find((entry) => entry.value.title === anonymous.title)
        ?.identity,
      undefined,
    );
    assert.ok(
      capture.entries.find((entry) => entry.value.title === control.name)
        ?.identity,
    );
    await assert.rejects(
      f.backend.press(target, anonymous.selector),
      /supports|unsupported/iu,
    );
    assert.equal(f.requests.length, 1);
    const fresh = await f.backend.inspect(target);
    const native = fresh.controls.find(
      (entry) => entry.title === control.name,
    )!;
    await f.backend.setValue(target, native.selector, "still exact 中文 😀");
    assert.equal(f.requests.at(-1)?.operation, "set_value");
    assert.deepEqual(f.requests.at(-1)?.control, control);
  } finally {
    await f.backend.close();
  }
});
test("empty RuntimeId is valid only for virtual read-only control records", () => {
  assert.doesNotThrow(() =>
    validateStrictUiaControl({ ...control, hwnd: "0", runtimeId: [] }),
  );
  for (const runtimeId of [[], null, Array(65).fill(1), [1.5]]) {
    assert.throws(() => validateStrictUiaRoot({ ...root, runtimeId }));
    assert.throws(() => validateStrictUiaControl({ ...control, runtimeId }));
  }
  for (const runtimeId of [null, Array(65).fill(1), [1.5]])
    assert.throws(() =>
      validateStrictUiaControl({ ...control, hwnd: "0", runtimeId }),
    );
});
test("dispatched native failures and broken replies are unknown and never retried", async () => {
  for (const action of [
    () => ({ outcome: "unknown", error: "pattern_failed" }),
    () => ({ value: "wrong" }),
    () => {
      throw new Error("pipe closed");
    },
  ]) {
    const f = fixture(action);
    try {
      const inspection = await f.backend.inspect(target);
      await assert.rejects(
        f.backend.setValue(target, inspection.controls[0]!.selector, "value"),
        /outcome unknown/iu,
      );
      assert.equal(
        f.requests.filter((r) => r.operation === "set_value").length,
        1,
      );
    } finally {
      await f.backend.close();
    }
  }
});
test("aborted before spawn remains not dispatched and closing revokes later actions", async () => {
  const f = fixture();
  const inspection = await f.backend.inspect(target);
  const signal = AbortSignal.abort(new Error("revoked"));
  await assert.rejects(
    f.backend.setValue(
      target,
      inspection.controls[0]!.selector,
      "value",
      signal,
    ),
    /not dispatched|revoked/iu,
  );
  assert.equal(f.requests.length, 1);
  await f.backend.close();
  await assert.rejects(f.backend.inspect(target), /closed|revoked/iu);
});

test("bounded native diagnostics preserve inspect refusal and uncertain action outcomes without retry", async () => {
  const reason = "provider_error_control_invoke_pattern_com_h80040201";
  const inspect = fixture(undefined, () => ({
    outcome: "not_dispatched",
    error: reason,
  }));
  try {
    await assert.rejects(
      inspect.backend.inspect(target),
      (error: unknown) =>
        error instanceof StrictUiaOperationError &&
        error.outcome === "not_dispatched" &&
        error.message.endsWith(reason),
    );
    assert.equal(inspect.requests.length, 1);
  } finally {
    await inspect.backend.close();
  }
  for (const outcome of ["not_dispatched", "unknown"] as const) {
    const action = fixture(() => ({ outcome, error: reason }));
    try {
      const observed = await action.backend.inspect(target);
      await assert.rejects(
        action.backend.press(target, observed.controls[0]!.selector),
        (error: unknown) =>
          error instanceof StrictUiaOperationError &&
          error.outcome === outcome &&
          error.message.endsWith(reason),
      );
      assert.equal(
        action.requests.filter((request) => request.operation === "invoke")
          .length,
        1,
      );
    } finally {
      await action.backend.close();
    }
  }
});

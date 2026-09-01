import assert from "node:assert/strict";
import test from "node:test";

import {
  computerCapabilityManifest,
  ComputerObservationLedger,
  ComputerZenXCapabilityPackage,
  type ComputerControlSelector,
  type ComputerInspection,
  type ComputerTarget,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";

const target: ComputerTarget = { pid: 42, windowTitle: "Smoke" };
const fieldControl: ComputerControlSelector = {
  observationId: "observation-1",
  targetId: "field",
};
const buttonControl: ComputerControlSelector = {
  observationId: "observation-1",
  targetId: "button",
};

test("computer vertical slice uses only targeted AX operations and does not echo set values", async () => {
  const calls: string[] = [];
  const capability = new ComputerZenXCapabilityPackage(computerBackend(calls));
  const inspected = (await capability.invoke(
    "computer_inspect",
    invocation({ target }),
  )) as ComputerInspection;
  assert.equal(inspected.target.applicationName, "Fixture");
  const pressed = await capability.invoke(
    "computer_press",
    invocation({ target, control: buttonControl }),
  );
  assert.deepEqual((pressed as { control: unknown }).control, buttonControl);
  await capability.invoke("computer_inspect", invocation({ target }));
  const set = await capability.invoke(
    "computer_set_value",
    invocation({
      target,
      control: fieldControl,
      value: "private deliberate text",
    }),
  );
  assert.equal((set as { characterCount: number }).characterCount, 23);
  assert.doesNotMatch(JSON.stringify(set), /private deliberate/u);
  assert.deepEqual(calls, [
    "inspect:42",
    "press:button",
    "inspect:42",
    "set:field:23",
  ]);
});

test("computer observation IDs are target-scoped and dispatch all ordinary values", () => {
  const ledger = new ComputerObservationLedger();
  const first = ledger.observe("app-a", [
    {
      role: "AXButton",
      title: "Mark",
      frame: "10.0,10.0,20.0,20.0",
      actions: ["press"],
    },
  ]);
  const firstControl = first.selectors[0]!;
  const second = ledger.observe("app-a", [
    {
      role: "AXButton",
      title: "Mark",
      frame: "20.0,10.0,20.0,20.0",
      actions: ["press"],
    },
  ]);
  assert.throws(
    () => ledger.consume("app-a", firstControl, "press"),
    /stale, unknown/u,
  );
  assert.throws(
    () =>
      ledger.consume(
        "app-a",
        { ...second.selectors[0]!, targetId: "forged" },
        "press",
      ),
    /forged/u,
  );
  assert.throws(
    () => ledger.consume("app-b", second.selectors[0]!, "press"),
    /another target/u,
  );

  const ordinary = ledger.observe("app-a", [
    {
      role: "AXTextField",
      subrole: "AXSecureTextField",
      frame: "10.0,40.0,100.0,20.0",
      actions: ["set_value"],
    },
  ]);
  assert.doesNotThrow(() =>
    ledger.consume("app-a", ordinary.selectors[0]!, "set_value"),
  );
});

test("declares background-safe semantics separately from foreground takeover", async () => {
  const modes = Object.fromEntries(
    computerCapabilityManifest.tools.map((tool) => [
      tool.name,
      tool.interactionMode,
    ]),
  );
  assert.equal(modes.computer_inspect, "background_safe");
  assert.equal(modes.computer_press, "background_safe");
  assert.equal(modes.computer_set_value, "background_safe");
  assert.equal(modes.computer_foreground_click, "foreground_required");
  assert.equal(modes.computer_foreground_type, undefined);

  const capability = new ComputerZenXCapabilityPackage(computerBackend([]));
  await assert.rejects(
    capability.invoke(
      "computer_set_value",
      invocation({ target, control: fieldControl, value: "x".repeat(4_001) }),
    ),
    /limited to 4000/u,
  );
  await assert.rejects(
    capability.invoke(
      "computer_screenshot",
      invocation({ target: { pid: 42 } }),
    ),
    /windowTitle/u,
  );
  await assert.rejects(
    capability.invoke("computer_inspect", invocation({ target: { pid: 42 } })),
    /cannot inspect or act across sibling windows/u,
  );
});

test("cancels foreground takeover before global input begins", async () => {
  const calls: string[] = [];
  const capability = new ComputerZenXCapabilityPackage(
    computerBackend(calls),
    computerCapabilityManifest,
    true,
  );
  const controller = new AbortController();
  controller.abort(new DOMException("stopped", "AbortError"));
  await assert.rejects(
    capability.invoke(
      "computer_foreground_click",
      invocation({ x: 10, y: 20 }, controller.signal),
    ),
    /stopped/u,
  );
  assert.deepEqual(calls, []);
});

test("executes the explicitly labeled foreground baseline after its cancellation window", async () => {
  const calls: string[] = [];
  const capability = new ComputerZenXCapabilityPackage(
    computerBackend(calls),
    computerCapabilityManifest,
    true,
  );
  const result = await capability.invoke(
    "computer_foreground_click",
    invocation({ x: 10, y: 20, button: "right" }),
  );
  assert.deepEqual(result, {
    action: "click",
    x: 10,
    y: 20,
    button: "right",
    impact: "foreground_takeover",
  });
  assert.deepEqual(calls, ["foreground-click:10:20:right"]);
});

test("direct Computer package construction fails closed for foreground tools", async () => {
  const calls: string[] = [];
  const capability = new ComputerZenXCapabilityPackage(computerBackend(calls));
  await assert.rejects(
    capability.invoke(
      "computer_foreground_click",
      invocation({ x: 10, y: 20 }),
    ),
    /foreground_required/u,
  );
  assert.deepEqual(calls, []);
});

test("revoking foreground consent fences a stale concurrent invocation before global input", async () => {
  const calls: string[] = [];
  const capability = new ComputerZenXCapabilityPackage(
    computerBackend(calls),
    computerCapabilityManifest,
    true,
  );
  const execution = capability.invoke(
    "computer_foreground_click",
    invocation({ x: 10, y: 20 }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  capability.setForegroundControlAllowed(false);

  await assert.rejects(execution, /foreground_required/u);
  assert.deepEqual(calls, []);
  await assert.rejects(
    capability.invoke(
      "computer_foreground_click",
      invocation({ x: 10, y: 20 }),
    ),
    /foreground_required/u,
  );
  assert.deepEqual(calls, []);
});

function computerBackend(calls: string[]): ZenXComputerBackend {
  const resolvedTarget = {
    pid: 42,
    bundleId: "dev.zen.fixture",
    applicationName: "Fixture",
    windowTitle: "Smoke",
  };
  return {
    inspect: async (inspectedTarget) => {
      calls.push(`inspect:${String(inspectedTarget.pid)}`);
      return {
        platform: "darwin",
        observationId: "observation-1",
        target: resolvedTarget,
        controls: [
          {
            selector: buttonControl,
            role: "AXButton",
            title: "Mark",
            enabled: true,
            actions: ["press"],
          },
          {
            selector: fieldControl,
            role: "AXTextField",
            title: "Name",
            enabled: true,
            actions: ["set_value"],
          },
        ],
        truncated: false,
      };
    },
    press: async (_target, selected) => {
      calls.push(`press:${selected.targetId}`);
      return { target: resolvedTarget, control: selected };
    },
    setValue: async (_target, selected, value) => {
      calls.push(`set:${selected.targetId}:${String(value.length)}`);
      return {
        target: resolvedTarget,
        control: selected,
        characterCount: value.length,
      };
    },
    screenshot: async () => ({
      artifactPath: "/private/tmp/fixture.png",
      target: resolvedTarget,
      width: 1200,
      height: 800,
      bytes: 100,
      expiresAt: new Date(0).toISOString(),
    }),
    foregroundClick: async (x, y, button) => {
      calls.push(`foreground-click:${String(x)}:${String(y)}:${button}`);
    },
    foregroundKeyPress: async (key) => {
      calls.push(`foreground-key:${key}`);
    },
    foregroundScroll: async (deltaY) => {
      calls.push(`foreground-scroll:${String(deltaY)}`);
    },
    close: () => undefined,
  };
}

function invocation(
  arguments_: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return {
    callId: "call-1",
    name: "test",
    arguments: arguments_,
    cwd: "/workspace",
    signal,
  };
}

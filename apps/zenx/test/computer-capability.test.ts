import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputerZenXCapabilityPackage,
  type ComputerState,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";

test("computer vertical slice audits explicit target context without echoing typed text", async () => {
  const calls: string[] = [];
  const capability = new ComputerZenXCapabilityPackage(computerBackend(calls));
  const inspected = (await capability.invoke(
    "computer_inspect",
    invocation({}),
  )) as ComputerState;
  assert.equal(inspected.frontmostApplication, "ZenX");
  const clicked = await capability.invoke(
    "computer_click",
    invocation({ x: 120, y: 80, context: "ZenX / Smoke / Continue" }),
  );
  assert.deepEqual((clicked as { action: unknown }).action, {
    x: 120,
    y: 80,
    button: "left",
    context: "ZenX / Smoke / Continue",
  });
  const typed = await capability.invoke(
    "computer_type",
    invocation({
      text: "private deliberate text",
      context: "ZenX / Smoke / Name",
    }),
  );
  assert.deepEqual((typed as { action: unknown }).action, {
    characterCount: 23,
    context: "ZenX / Smoke / Name",
  });
  assert.doesNotMatch(JSON.stringify(typed), /private deliberate/u);
  await capability.invoke(
    "computer_key_press",
    invocation({ key: "enter", context: "ZenX / Smoke / Name" }),
  );
  await capability.invoke(
    "computer_scroll",
    invocation({ deltaY: 500, context: "ZenX / Smoke / List" }),
  );
  assert.deepEqual(calls, [
    "inspect",
    "click:120:80:left",
    "type:23",
    "key:enter",
    "scroll:500",
  ]);
});

test("computer input requires explicit context and bounded operations", async () => {
  const capability = new ComputerZenXCapabilityPackage(computerBackend([]));
  await assert.rejects(
    capability.invoke("computer_click", invocation({ x: 1, y: 2 })),
    /context/u,
  );
  await assert.rejects(
    capability.invoke(
      "computer_scroll",
      invocation({ deltaY: 20_000, context: "target" }),
    ),
    /between -10000 and 10000/u,
  );
});

function computerBackend(calls: string[]): ZenXComputerBackend {
  const state: ComputerState = {
    platform: "darwin",
    frontmostApplication: "ZenX",
    frontmostWindowTitle: "Smoke",
    cursor: { x: 10, y: 10 },
    displays: [
      {
        id: "1",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        scaleFactor: 2,
      },
    ],
  };
  return {
    inspect: async () => {
      calls.push("inspect");
      return state;
    },
    screenshot: async () => ({
      artifactPath: "/private/tmp/fixture.png",
      sourceId: "screen:1",
      sourceName: "Display 1",
      width: 1200,
      height: 800,
      bytes: 100,
      expiresAt: new Date(0).toISOString(),
    }),
    click: async (x, y, button) => {
      calls.push(`click:${String(x)}:${String(y)}:${button}`);
      return state;
    },
    type: async (text) => {
      calls.push(`type:${String(text.length)}`);
      return state;
    },
    keyPress: async (key) => {
      calls.push(`key:${key}`);
      return state;
    },
    scroll: async (deltaY) => {
      calls.push(`scroll:${String(deltaY)}`);
      return state;
    },
    close: () => undefined,
  };
}

function invocation(arguments_: Record<string, unknown>) {
  return {
    callId: "call-1",
    name: "test",
    arguments: arguments_,
    cwd: "/workspace",
    signal: new AbortController().signal,
  };
}

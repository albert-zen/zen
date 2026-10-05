import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { pluginReadiness, requirementsReady } from "../src/plugin-readiness.js";
import type { ZenXPluginSummary } from "../src/main/capabilities/types.js";
import { PluginRequirementsPreview } from "../src/renderer/src/PluginRequirementsPreview.js";

const summaries = (enabled = true) =>
  [
    {
      id: "messaging",
      displayName: "Messaging",
      lifecycle: enabled ? "enabled" : "installed",
      enabled,
      available: true,
    },
    {
      id: "tasks",
      displayName: "Tasks",
      lifecycle: "enabled",
      enabled: true,
      available: false,
    },
  ] as ZenXPluginSummary[];
const requirements = [
  { pluginId: "messaging", purpose: "Receive messages", required: true },
  { pluginId: "tasks", purpose: "Run tasks", required: false },
];

test("generic requirements distinguish missing, disabled and unavailable without requiring optional tools", () => {
  const result = pluginReadiness(summaries(), [
    "messaging",
    "tasks",
    "missing",
    "messaging",
  ]);
  assert.deepEqual(
    result.map((entry) => entry.state),
    ["ready", "unavailable", "missing"],
  );
  assert.equal(requirementsReady(requirements, result), true);
  assert.equal(
    requirementsReady(
      requirements,
      pluginReadiness(summaries(false), ["messaging"]),
    ),
    false,
  );
});

test("generic readiness preview observes newer lifecycle and performs no enablement", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let release: ((value: unknown) => void) | undefined;
  let listener: ((value: unknown) => void) | undefined;
  let unsubscribed = false;
  const ready: boolean[] = [];
  let opened = false;
  Object.assign(window, {
    zenx: {
      plugins: {
        get: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        onChange: (fn: (value: unknown) => void) => {
          listener = fn;
          return () => {
            unsubscribed = true;
          };
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(PluginRequirementsPreview, {
          requirements,
          onReady: (value) => ready.push(value),
          openSettings: () => {
            opened = true;
          },
        }),
      ),
    );
    await act(async () => listener!({ plugins: summaries(false) }));
    await act(async () => release!({ plugins: summaries(true) }));
    assert.match(
      document.body.textContent ?? "",
      /Receive messages: Enable plugin/,
    );
    assert.match(
      document.body.textContent ?? "",
      /Run tasks: Check plugin \(optional\)/,
    );
    assert.equal(
      ready.at(-1),
      false,
      "stale initial load cannot overwrite a newer disable",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("button")!.click(),
    );
    assert.equal(opened, true);
  } finally {
    await act(async () => root.unmount());
    assert.equal(unsubscribed, true);
    dom.window.close();
  }
});

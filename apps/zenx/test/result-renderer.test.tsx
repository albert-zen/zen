import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { projectCommandCompleted } from "../../../src/protocol/codex/mapper.js";
import type { ToolCallItem, ToolResultItem } from "../../../src/item.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { ToolResultRenderer } from "../src/renderer/src/ToolResultRenderer.js";
import {
  createPluginUiRegistry,
  type PluginUiModule,
} from "../src/renderer/src/plugin-ui-host.js";

const call: ToolCallItem = {
  id: "call-item",
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-08-24T00:00:00.000Z",
  type: "tool_call",
  callId: "call",
  name: "fixture_cards",
  arguments: {},
};
const result: ToolResultItem = {
  id: "result-item",
  threadId: "thread",
  turnId: "turn",
  createdAt: "2026-08-24T00:00:01.000Z",
  type: "tool_result",
  callId: "call",
  output: "text fallback",
  exitCode: 0,
  contentType: "fixture/cards",
  structuredContent: { cards: [{ title: "One" }] },
};

function snapshot(
  kind: "trusted" | "isolated" = "trusted",
): ZenXPluginSnapshot {
  return {
    plugins: [
      {
        id: "fixture",
        displayName: "Fixture",
        version: "1.0.0",
        source: "bundled",
        lifecycle: "enabled",
        enabled: true,
        available: true,
        contributionCount: 1,
      },
    ],
    bundles: [
      {
        key: "fixture:main",
        pluginId: "fixture",
        id: "main",
        apiVersion: 1,
        kind,
        entry:
          kind === "trusted" ? "fixture-ui" : "<main>isolated cards</main>",
      },
    ],
    surfaces: [
      {
        key: "fixture:cards",
        pluginId: "fixture",
        id: "cards",
        bundleId: "main",
        exportName: "cards",
      },
    ],
    resultRenderers: [
      {
        key: "fixture:cards",
        pluginId: "fixture",
        id: "cards",
        contentType: "fixture/cards",
        surfaceId: "cards",
      },
    ],
    sidebar: [],
    pages: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
  };
}

function installDom(): JSDOM {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      plugins: {
        executeCommand: async () => null,
        readHandle: async () => null,
      },
    },
  });
  return dom;
}

test("trusted result renderer receives immutable structured data and lifecycle fallback restores without rewriting the item", async () => {
  const dom = installDom();
  let mounts = 0;
  let mutationBlocked = false;
  const module: PluginUiModule = {
    cards: ({ sdk }) => {
      mounts += 1;
      const context = sdk.context as {
        structuredContent: { cards: Array<{ title: string }> };
        fallback: { output: string };
      };
      try {
        context.structuredContent.cards[0]!.title = "changed";
      } catch {
        mutationBlocked = true;
      }
      return React.createElement(
        "p",
        { role: "status" },
        `${context.structuredContent.cards[0]!.title}:${context.fallback.output}`,
      );
    },
  };
  const registry = createPluginUiRegistry();
  registry.registerTrusted("fixture-ui", module);
  const item = projectCommandCompleted(call, result, "/workspace");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (current: ZenXPluginSnapshot | null) =>
    await act(async () =>
      root.render(
        React.createElement(ToolResultRenderer, {
          item,
          snapshot: current,
          registry,
          theme: "light",
        }),
      ),
    );
  await render(snapshot());
  assert.equal(
    dom.window.document.querySelector("[role=status]")?.textContent,
    "One:text fallback",
  );
  assert.equal(mutationBlocked, true);
  await render({
    ...snapshot(),
    bundles: [],
    surfaces: [],
    resultRenderers: [],
  });
  assert.match(dom.window.document.body.textContent, /"title": "One"/u);
  assert.match(dom.window.document.body.textContent, /text fallback/u);
  await render(snapshot());
  assert.equal(
    dom.window.document.querySelectorAll(
      "[data-plugin-surface='fixture:cards']",
    ).length,
    1,
  );
  assert.equal(mounts, 2);
  assert.deepEqual(result.structuredContent, { cards: [{ title: "One" }] });
  await act(async () => root.unmount());
});

test("isolated result renderer uses the ZP6 sandbox and receives the same bounded context", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(ToolResultRenderer, {
        item: projectCommandCompleted(call, result, "/workspace"),
        snapshot: snapshot("isolated"),
        registry: createPluginUiRegistry(),
        theme: "dark",
      }),
    ),
  );
  const frame = dom.window.document.querySelector("iframe")!;
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.doesNotMatch(frame.getAttribute("sandbox")!, /allow-same-origin/u);
  assert.match(frame.srcdoc, /fixture\\u002fcards|fixture\/cards/u);
  assert.match(frame.srcdoc, /text fallback/u);
  await act(async () => root.unmount());
});

test("unknown historical structured result is always readable through deterministic JSON and text fallback", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(ToolResultRenderer, {
        item: projectCommandCompleted(call, result, "/workspace"),
        snapshot: null,
        registry: null,
        theme: "light",
      }),
    ),
  );
  assert.equal(
    dom.window.document
      .querySelector("[aria-label='Tool result']")
      ?.textContent?.replaceAll(/\s/gu, ""),
    '{"cards":[{"title":"One"}]}textfallbackExitcode0',
  );
  await act(async () => root.unmount());
});

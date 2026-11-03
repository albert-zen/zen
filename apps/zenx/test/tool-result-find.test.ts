import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { CommandItem, Turn } from "../src/protocol-client/index.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { ToolResultRenderer } from "../src/renderer/src/ToolResultRenderer.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import {
  resolveToolResultPresentation,
  toolResultFallbackText,
} from "../src/renderer/src/tool-result-presentation.js";
import {
  createTranscriptFindIndexer,
  searchTranscript,
} from "../src/renderer/src/transcript-find-index.js";
import { transcriptFindRange } from "../src/renderer/src/transcript-find-ranges.js";

const item = {
  type: "commandExecution",
  id: "call",
  pluginId: null,
  scriptPath: null,
  command: "fixture",
  cwd: "/workspace/zen",
  processId: null,
  source: "agent",
  status: "failed",
  commandActions: [],
  durationMs: null,
  contentType: "fixture/cards",
  structuredContent: { title: "Needle card", code: "**literal**" },
  aggregatedOutput: "Needle output\nexact second line",
  exitCode: 7,
} satisfies CommandItem;
function snapshot(
  kind: "trusted" | "isolated" = "trusted",
): ZenXPluginSnapshot {
  return {
    plugins: [],
    bundles: [
      {
        key: "fixture:main",
        pluginId: "fixture",
        id: "main",
        apiVersion: 1,
        kind,
        entry: kind === "trusted" ? "fixture-ui" : "<main>opaque</main>",
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
function indexItem(
  command: CommandItem,
  current: ZenXPluginSnapshot | null,
  registry: ReturnType<typeof createPluginUiRegistry> | null,
  index = createTranscriptFindIndexer(),
) {
  return index(
    [{ id: "t", status: "completed", items: [command] } as Turn],
    new Map(),
    [],
    { snapshot: current, registry },
  );
}
function renderItem(
  command: CommandItem,
  current: ZenXPluginSnapshot | null,
  registry: ReturnType<typeof createPluginUiRegistry> | null,
) {
  Object.defineProperty(window, "zenx", {
    configurable: true,
    value: {
      plugins: {
        executeCommand: async () => null,
        readHandle: async () => null,
      },
    },
  });
  return new JSDOM(
    renderToStaticMarkup(
      React.createElement(
        "main",
        null,
        React.createElement(ToolResultRenderer, {
          item: command,
          snapshot: current,
          registry,
          theme: "light",
        }),
      ),
    ),
  );
}

test("Find indexes exactly the real fallback pre bodies and resolves exact connected ranges", () => {
  const registry = createPluginUiRegistry();
  for (const current of [
    null,
    snapshot(),
    { ...snapshot(), surfaces: [] },
    { ...snapshot(), bundles: [] },
    { ...snapshot(), resultRenderers: [] },
  ]) {
    assert.deepEqual(resolveToolResultPresentation(item, current, registry), {
      kind: "fallback",
    });
    const entries = indexItem(item, current, registry);
    const dom = renderItem(item, current, registry);
    const pre = [...dom.window.document.querySelectorAll("pre")];
    const text = toolResultFallbackText(item);
    assert.deepEqual(
      pre.map((node) => node.textContent),
      [text.structured, text.output],
      "same pure text contract is actually rendered",
    );
    assert.equal(
      entries.find((entry) => entry.field === "tool-structured")!.blocks[0],
      text.structured!.replace(/\s+/gu, " ").trim(),
    );
    const matches = searchTranscript(entries, "Needle");
    assert.deepEqual(
      matches.map((match) => match.entry.field),
      ["tool-structured", "output"],
    );
    for (const match of matches)
      assert.equal(
        transcriptFindRange(
          dom.window.document.querySelector("main")!,
          match,
          "Needle",
        )?.toString(),
        "Needle",
      );
    assert.equal(
      searchTranscript(entries, "Exit code").length,
      0,
      "unrelated UI metadata is not product text",
    );
    assert.equal(
      searchTranscript(entries, "**literal**").length,
      1,
      "structured pre text stays literal rather than Markdown-parsed",
    );
    dom.window.close();
  }
});

test("pure resolver selects opaque trusted/isolated surfaces without mounting or serializing their state", () => {
  const registry = createPluginUiRegistry();
  let mounts = 0,
    serializations = 0;
  registry.registerTrusted("fixture-ui", {
    cards: () => {
      mounts++;
      return React.createElement("p", null, "Opaque presentation");
    },
  });
  const structured = { title: "Hidden Needle" };
  Object.defineProperty(structured, "toJSON", {
    value() {
      serializations++;
      throw new Error("opaque state must not be serialized for Find");
    },
  });
  const opaque = { ...item, structuredContent: structured };
  for (const current of [snapshot(), snapshot("isolated")]) {
    assert.equal(
      resolveToolResultPresentation(opaque, current, registry).kind,
      "plugin",
    );
    const entries = indexItem(opaque, current, registry);
    assert.equal(searchTranscript(entries, "Hidden Needle").length, 0);
    assert.equal(
      searchTranscript(entries, "Needle output").length,
      0,
      "plugin context fallback is not itself visible fallback text",
    );
    assert.equal(mounts, 0);
    assert.equal(serializations, 0);
  }
  const dom = renderItem(item, snapshot(), registry);
  assert.equal(
    dom.window.document.querySelector("pre"),
    null,
    "actual plugin branch contains no fallback pre",
  );
  assert.equal(
    dom.window.document.querySelector("[data-plugin-surface]")?.textContent,
    "Opaque presentation",
  );
  assert.equal(
    mounts,
    1,
    "only the explicit actual-renderer contract mounts this synthetic surface",
  );
  dom.window.close();
});

test("immutable cache tracks registry availability changes without reserializing unchanged fallback data", () => {
  const registry = createPluginUiRegistry(),
    current = snapshot();
  let serializations = 0;
  const structured = { ...item.structuredContent };
  Object.defineProperty(structured, "toJSON", {
    value() {
      serializations++;
      return { title: "Needle card" };
    },
  });
  const tracked = { ...item, structuredContent: structured };
  const source = [{ id: "t", status: "completed", items: [tracked] } as Turn];
  const index = createTranscriptFindIndexer(),
    canonical = new Map();
  const read = () =>
    index(source, canonical, [], { snapshot: current, registry });
  assert.equal(searchTranscript(read(), "Needle").length, 2);
  assert.equal(serializations, 1);
  read();
  assert.equal(
    serializations,
    1,
    "unchanged immutable fallback text is not serialized again",
  );
  const unregister = registry.registerTrusted("fixture-ui", {
    cards: () => {
      throw new Error("Find must not mount the surface");
    },
  });
  assert.equal(
    searchTranscript(read(), "Needle").length,
    0,
    "same registry identity with a newly available surface invalidates fallback text",
  );
  assert.equal(
    serializations,
    1,
    "switching to opaque UI never serializes its structured state",
  );
  unregister();
  assert.equal(searchTranscript(read(), "Needle").length, 2);
  assert.equal(serializations, 2);
  assert.equal(searchTranscript(read(), "Needle").length, 2);
  assert.equal(serializations, 2);
  assert.equal(
    resolveToolResultPresentation(
      { ...item, structuredContent: undefined },
      current,
      registry,
    ).kind,
    "fallback",
  );
});

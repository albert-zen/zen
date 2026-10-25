import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { TriggersPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("management hierarchy preserves definition facts and read-only Edit/Cancel flow", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const calls: string[] = [];
  const sdk = {
    context: {},
    navigation: { navigate() {} },
    commands: {
      async execute(command: string) {
        calls.push(command);
        if (command === "list")
          return {
            triggers: [
              {
                id: "timer",
                label: "Research brief",
                threadId: "research",
                kind: "timer",
                active: true,
                prompt: "Keep exact instructions",
                createdAt: 1,
                timer: {
                  nextRunAt: Date.now() + 86400000,
                  intervalMinutes: 1440,
                },
              },
            ],
            history: [
              {
                id: "invalid-finite-time",
                triggerId: "timer",
                threadId: "research",
                startedAt: 1e20,
                status: "queued",
                reason: "Synthetic invalid timestamp",
              },
            ],
          };
        if (command === "threads")
          return {
            threads: [
              {
                threadId: "research",
                name: "Research",
                shortId: "research",
                cwd: "/synthetic",
                status: "idle",
                archived: false,
              },
            ],
          };
        if (command === "workspaces") return { workspaces: [] };
        throw new Error("Unexpected mutation");
      },
    },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    assert.match(
      document.querySelector(".trigger-run-time")?.textContent ?? "",
      /Invalid Date/,
    );
    const header = document.querySelector(".trigger-manager-header")!;
    assert.match(header.textContent ?? "", /New trigger/);
    const card = document.querySelector(".trigger-card")!;
    assert.equal(card.querySelector("h3")?.textContent, "Research brief");
    assert.equal(card.querySelector(".trigger-state")?.textContent, "Enabled");
    assert.equal(card.querySelectorAll("dl.trigger-facts > div").length, 2);
    assert.match(
      card.querySelector(".trigger-facts")?.textContent ?? "",
      /Research/,
    );
    assert.equal(
      card.querySelector(".trigger-instructions")?.textContent,
      "Keep exact instructions",
    );
    const edit = card.querySelector<HTMLButtonElement>(
      ".trigger-actions button",
    )!;
    await React.act(async () => edit.click());
    const editor = document.querySelector(".trigger-editor")!;
    assert.equal(
      editor.querySelector("textarea")?.value,
      "Keep exact instructions",
    );
    const cancel = [...editor.querySelectorAll("button")].find(
      (e) => e.textContent === "Cancel",
    )!;
    await React.act(async () => cancel.click());
    assert.equal(document.querySelector(".trigger-editor"), null);
    assert(calls.every((c) => ["list", "threads", "workspaces"].includes(c)));
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

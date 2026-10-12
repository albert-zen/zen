import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { ShellThreadPanel } from "../src/renderer/src/shell-thread-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";

async function mount() {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  return {
    dom,
    root,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("Terminal entry opens a session-management homepage; closing its tab never stops or creates a Shell", async () => {
  const fixture = await mount();
  const calls: string[] = [];
  (fixture.dom.window as any).zenx = {
    shellPanel: {
      request: async (input: any) => {
        calls.push(input.operation);
        return {
          sessions: [],
          cwd: "/workspace/project",
          host: "local",
          canCreate: true,
        };
      },
    },
  };
  let tab = "terminal";
  try {
    await act(async () =>
      fixture.root.render(
        React.createElement(AuxiliaryPanel, {
          threadId: "thread",
          title: "Task",
          open: true,
          onOpenChange() {},
          snapshot: null,
          selectedTab: tab,
          openedTabs: [tab],
          onSelectTab(next) {
            tab = next;
          },
          onTabsChange() {},
        }),
      ),
    );
    assert.match(
      fixture.dom.window.document.body.textContent!,
      /No Shell sessions yet/,
    );
    assert.match(
      fixture.dom.window.document.body.textContent!,
      /workspace\/project/,
    );
    assert.deepEqual(calls, ["list"]);
    const close =
      fixture.dom.window.document.querySelector<HTMLButtonElement>(
        '[aria-label="Close Terminal"]',
      ) ??
      fixture.dom.window.document.querySelector<HTMLButtonElement>(
        ".workspace-tab-close",
      );
    assert(close);
    await act(async () => close.click());
    assert.deepEqual(calls, ["list"]);
  } finally {
    await fixture.close();
  }
});

test("repeated creation gestures send once and a late reply cannot move a different thread's view", async () => {
  const fixture = await mount();
  const calls: any[] = [];
  let finish!: (value: unknown) => void;
  (fixture.dom.window as any).zenx = {
    shellPanel: {
      request: async (input: any) => {
        calls.push(input);
        if (input.operation === "create")
          return await new Promise((r) => {
            finish = r;
          });
        return {
          sessions: [],
          cwd: input.threadId,
          host: "local",
          canCreate: true,
        };
      },
    },
  };
  try {
    await act(async () =>
      fixture.root.render(
        React.createElement(ShellThreadPanel, {
          threadId: "first",
          active: true,
        }),
      ),
    );
    const button = [
      ...fixture.dom.window.document.querySelectorAll("button"),
    ].find((b) => b.textContent === "New terminal")!;
    await act(async () => {
      button.click();
      button.click();
    });
    assert.equal(calls.filter((c) => c.operation === "create").length, 1);
    await act(async () =>
      fixture.root.render(
        React.createElement(ShellThreadPanel, {
          threadId: "second",
          active: true,
        }),
      ),
    );
    await act(async () =>
      finish({
        taskId: "old-session",
        threadId: "first",
        command: "old terminal",
      }),
    );
    assert.doesNotMatch(
      fixture.dom.window.document.body.textContent!,
      /old terminal/,
    );
    assert.match(fixture.dom.window.document.body.textContent!, /second/);
  } finally {
    await fixture.close();
  }
});

test("terminal output cannot register OSC hyperlinks or clipboard actions", async () => {
  const dom = new JSDOM("<body></body>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const module = await import("@xterm/xterm");
  // node loads xterm's CJS entry; the renderer uses its ESM export.
  const Terminal = module.Terminal ?? (module as any).default.Terminal;
  const { restrictTerminalOutput } =
    await import("../src/renderer/src/shell-terminal-security.js");
  const terminal = new Terminal({ disableStdin: true });
  restrictTerminalOutput(terminal);
  try {
    await new Promise<void>((resolve) =>
      terminal.write(
        "\x1b]8;;https://example.invalid/\x07CLICK\x1b]8;;\x07" +
          "\x1b]52;c;c2VjcmV0\x07",
        resolve,
      ),
    );
    const providers = (terminal as any)._core._linkProviderService
      .linkProviders;
    for (const provider of providers) {
      const links = await new Promise<any[]>((resolve) =>
        provider.provideLinks(1, (value: any[]) => resolve(value ?? [])),
      );
      assert.equal(
        links.length,
        0,
        "untrusted output cannot create active links",
      );
    }
    assert.match(
      terminal.buffer.active.getLine(0)!.translateToString(),
      /CLICK/,
    );
  } finally {
    terminal.dispose();
    dom.window.close();
  }
});

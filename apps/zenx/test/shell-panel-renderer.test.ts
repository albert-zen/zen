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
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
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

test("overview keeps IDs and lifetime limits in optional details", async () => {
  const fixture = await mount();
  const taskId = "opaque-task-id-not-primary-content";
  (fixture.dom.window as any).zenx = {
    shellPanel: {
      request: async () => ({
        sessions: [
          {
            taskId,
            threadId: "thread",
            origin: "user",
            kind: "terminal",
            command: "Interactive shell",
            cwd: "/tmp/demo",
            createdAt: new Date().toISOString(),
            status: "running",
            exitCode: null,
            inputAvailable: true,
            retained: false,
          },
        ],
        cwd: "/tmp/demo",
        host: "local",
        canCreate: true,
      }),
    },
  };
  try {
    await act(async () =>
      fixture.root.render(
        React.createElement(ShellThreadPanel, {
          threadId: "thread",
          active: true,
        }),
      ),
    );
    const card = fixture.dom.window.document.querySelector(
      ".shell-session-card",
    )!;
    assert(!card.textContent!.includes(taskId));
    const footer =
      fixture.dom.window.document.querySelector(".shell-lifetime")!;
    assert.equal(
      footer.querySelector("p")!.textContent,
      "Closing the panel keeps sessions running.",
    );
    assert.equal(footer.querySelector("details")!.open, false);
    assert(!fixture.dom.window.document.body.textContent!.includes("24-hour"));
  } finally {
    await fixture.close();
  }
});

test("selected terminal keeps compact controls, optional metadata, and explicit stop confirmation", async () => {
  const fixture = await mount();
  const calls: string[] = [];
  const session = {
    taskId: "synthetic-task",
    threadId: "thread",
    origin: "user",
    kind: "terminal",
    command: "Interactive shell",
    cwd: "/workspace/project",
    createdAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    inputAvailable: true,
    retained: false,
  };
  (fixture.dom.window as any).zenx = {
    shellPanel: {
      request: async (input: any) => {
        calls.push(input.operation);
        if (input.operation === "create") return session;
        return {
          sessions: [session],
          cwd: session.cwd,
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
          threadId: "thread",
          active: true,
        }),
      ),
    );
    await act(async () =>
      fixture.dom.window.document
        .querySelector<HTMLButtonElement>(".shell-session-card")!
        .click(),
    );
    const doc = fixture.dom.window.document;
    assert.equal(
      doc.querySelector(".shell-panel h3"),
      null,
      "the tab already supplies the Terminal title",
    );
    assert.equal(
      doc.querySelector(".shell-session-heading"),
      null,
      "controls share the compact toolbar",
    );
    const details = doc.querySelector<HTMLDetailsElement>(
      ".shell-session-details",
    )!;
    assert(details);
    assert.equal(details.open, false);
    assert.match(details.textContent!, /synthetic-task/);
    assert.match(
      doc.querySelector(".shell-lifetime")!.textContent!,
      /You control input.*Closing the panel keeps sessions running/,
    );
    const stop = doc.querySelector<HTMLButtonElement>(".shell-stop")!;
    await act(async () => stop.click());
    assert(doc.querySelector('[role="alertdialog"]'));
    assert(!calls.includes("stop"));
    await act(async () =>
      [...doc.querySelectorAll<HTMLButtonElement>(".shell-stop-confirm button")]
        .find((b) => b.textContent === "Cancel")!
        .click(),
    );
    assert.equal(doc.querySelector('[role="alertdialog"]'), null);
    assert(!calls.includes("stop"));
    await act(async () => fixture.root.unmount());
    assert(!calls.includes("stop"));
  } finally {
    await fixture.close();
  }
});

test("terminal panel fills its flex host instead of keeping intrinsic width", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../src/renderer/src/shell-thread-panel.css", import.meta.url),
    "utf8",
  );
  const panel = css.match(/\.shell-panel\s*\{([^}]+)\}/)![1]!;
  assert.match(panel, /flex:\s*1(?:\s+1\s+0)?;/);
  assert.match(panel, /min-width:\s*0;/);
  assert.match(panel, /width:\s*100%;/);
  const surface = css.match(/\.shell-terminal\s*\{([^}]+)\}/)![1]!;
  assert.match(surface, /min-height:\s*0;/);
  assert.match(surface, /box-sizing:\s*border-box;/);
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(
    coarse,
    /\.shell-panel :is\(\.primary-button, \.secondary-button\)/,
  );
  assert.match(coarse, /min-height:\s*44px;/);
  assert.match(coarse, /min-width:\s*44px;/);
  assert.doesNotMatch(css, /\.shell-status\[data-status="failed"\]/);
  const source = await readFile(
    new URL("../src/renderer/src/shell-thread-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /body\{padding:0\}\.xterm\{height:100%;box-sizing:border-box;padding:10px\}/,
  );
});

test("ended session labels stay neutral while exit code and specific timeout facts remain", async () => {
  const fixture = await mount();
  const session = {
    taskId: "ended-command",
    threadId: "thread",
    origin: "agent",
    kind: "command",
    command: "grep missing README.md",
    cwd: "/workspace/project",
    createdAt: new Date().toISOString(),
    status: "failed",
    exitCode: 1,
    inputAvailable: false,
    retained: true,
  };
  (fixture.dom.window as any).zenx = {
    shellPanel: {
      request: async () => ({
        sessions: [session],
        cwd: session.cwd,
        host: "local",
        canCreate: true,
      }),
    },
  };
  try {
    await act(async () =>
      fixture.root.render(
        React.createElement(ShellThreadPanel, {
          threadId: "thread",
          active: true,
        }),
      ),
    );
    const doc = fixture.dom.window.document;
    assert.equal(doc.querySelector(".shell-status")!.textContent, "Ended");
    await act(async () =>
      doc.querySelector<HTMLButtonElement>(".shell-session-card")!.click(),
    );
    assert.equal(
      doc.querySelector(".shell-status")!.getAttribute("data-status"),
      "failed",
    );
    assert.equal(doc.querySelector(".shell-exit")!.textContent, "Exit code: 1");
    assert.equal(doc.querySelector(".shell-stop"), null);
    assert.equal(i18n.t("panels:shellStatus_timed_out"), "Timed out");
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.equal(doc.querySelector(".shell-status")!.textContent, "已结束");
    assert.equal(i18n.t("panels:shellStatus_timed_out"), "已超时");
  } finally {
    await fixture.close();
  }
});

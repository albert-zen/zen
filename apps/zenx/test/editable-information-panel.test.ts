import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EditableInformationPanel } from "../src/renderer/src/EditableInformationPanel.js";
import { NativeInformationService } from "../src/main/native-information-service.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import type { NativeInformationUpdate } from "../src/native-information.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { workspaceLauncherSnapshot } from "./workspace-launcher-snapshot.js";
import { i18n } from "../src/renderer/src/i18n.js";

async function fixture(kind: "thread" | "room" = "thread") {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), "editable-information-ui-"),
  );
  const store = new ThreadSidebarStore(directory);
  let members = [{ threadId: "member", name: "Synthetic member" }];
  const service = new NativeInformationService({
    sidebar: store,
    assertThreadExists: async () => {},
    rooms: () => [{ id: "room", assistant: { threadId: "member" }, members }],
  });
  const scope = { kind, id: kind === "thread" ? "member" : "room" };
  const updates: NativeInformationUpdate[] = [];
  let reads = 0;
  let fail: "conflict" | "unknown" | null = null;
  let updateGate: Promise<void> | undefined;
  let readGate: Promise<void> | undefined;
  const api = {
    // The synthetic port explicitly stands in for the separately tested native
    // owned-document lease; production preload cannot supply this callback.
    read: async (owner: typeof scope) => {
      reads++;
      const captured = await service.read(owner, () => {});
      await readGate;
      return captured;
    },
    update: async (input: NativeInformationUpdate) => {
      updates.push(structuredClone(input));
      await updateGate;
      if (fail === "conflict") {
        fail = null;
        await store.update({
          owner: scope,
          expectedRevision: input.expectedRevision,
          patch: { open: true },
        });
      }
      const result = await service.update(input, () => {});
      if (fail === "unknown") {
        fail = null;
        throw Error("Synthetic lost reply");
      }
      return result;
    },
  };
  Object.assign(dom.window, {
    zenx: {
      information: api,
      threadSidebar: { onChanged: () => () => {} },
      plugins: {
        executeCommand: async () => ({
          triggers: [
            {
              id: "timer",
              threadId: "member",
              kind: "timer",
              active: true,
              label: "Synthetic timer",
            },
            {
              id: "paused",
              threadId: "member",
              kind: "signal",
              active: false,
              label: "Synthetic paused event",
            },
            {
              id: "foreign",
              threadId: "foreign",
              kind: "timer",
              active: true,
              label: "Private foreign fact",
            },
          ],
        }),
        readHandle: async () => null,
      },
      shellPanel: {
        request: async () => ({
          host: "local",
          sessions: [],
          cwd: "/synthetic",
          canCreate: false,
        }),
      },
    },
  });
  const snapshot = {
    ...workspaceLauncherSnapshot,
    panels: [],
    plugins: workspaceLauncherSnapshot.plugins.map((p) => ({
      ...p,
      admissionId: "fixture",
    })),
    commands: [
      {
        key: "zenx-triggers:sidebar-facts",
        pluginId: "zenx-triggers",
        id: "sidebar-facts",
        title: "Facts",
        tool: "zenx_triggers_sidebar_facts",
      },
    ],
  };
  const registry = createPluginUiRegistry();
  const threads: never[] = [];
  const root = createRoot(document.getElementById("root")!);
  const attention = React.createElement(
    "div",
    { id: "asking-attention" },
    "Unanswered question remains available",
  );
  const render = async (extra = 0) =>
    act(async () => {
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement("p", null, `Synthetic transcript delta ${extra}`),
          React.createElement(EditableInformationPanel, {
            owner:
              kind === "thread"
                ? { kind, threadId: "member" }
                : { kind, roomId: "room" },
            threads,
            snapshot,
            registry,
            theme: "light",
            navigate: () => {},
            attention,
          }),
        ),
      );
    });
  await render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const click = async (text: string, container: ParentNode = document) => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (element) =>
        element.textContent === text ||
        element.getAttribute("aria-label") === text,
    );
    assert.ok(button, `Missing button ${text}`);
    await act(async () => {
      button.click();
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        !document.querySelector<HTMLButtonElement>(
          '[aria-label="Refresh information"]',
        )?.disabled
      )
        break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  };
  const row = (type: string) =>
    document.querySelector<HTMLElement>(
      `[data-widget-id="default:${type}${kind === "room" && !["board", "room-members"].includes(type) ? "@member" : ""}"]`,
    )!;
  const change = async (
    element: HTMLSelectElement | HTMLInputElement,
    value: string,
  ) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        element instanceof dom.window.HTMLSelectElement
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(element, value);
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  return {
    dom,
    store,
    service,
    scope,
    api,
    updates,
    readCount: () => reads,
    render,
    hide: () =>
      act(async () =>
        root.render(React.createElement("div", null, "Panel closed")),
      ),
    hold: () => {
      let release!: () => void;
      updateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        updateGate = undefined;
        release();
      };
    },
    holdRead: () => {
      let release!: () => void;
      readGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        readGate = undefined;
        release();
      };
    },
    click,
    row,
    change,
    fail: (value: typeof fail) => {
      fail = value;
    },
    clearMembers: () => {
      members = [];
    },
    close: async () => {
      await act(async () => root.unmount());
      await store.close();
      await rm(directory, { recursive: true, force: true });
      dom.window.close();
    },
  };
}

test("actual editable panel uses native CAS for hide/show/remove/reorder/reset and keeps Asking outside widgets", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.updates.length,
      0,
      "reading default layout must not persist it",
    );
    assert.match(
      document.body.textContent!,
      /no admitted Thread-to-pull-request provider/,
    );
    assert.match(
      document.body.textContent!,
      /no admitted related-artifact index/,
    );
    assert.doesNotMatch(document.body.textContent!, /Private foreign fact/);
    await f.click("Customize information");
    await f.click("Move up · Board");
    assert.equal(
      (await f.store.read(f.scope)).informationLayout!.widgets.at(-2)!.type,
      "board",
    );
    for (const row of [
      ...document.querySelectorAll<HTMLElement>(".information-widget"),
    ])
      await f.click("Hide", row);
    assert.equal(
      document.querySelectorAll(".information-widget-body").length,
      0,
    );
    assert.ok(document.querySelector("#asking-attention"));
    assert.match(document.body.textContent!, /All components are hidden/);
    await f.click("Show", f.row("triggers"));
    assert.match(f.row("triggers").textContent!, /Synthetic timer/);
    await f.click("Remove placement · Background commands");
    assert.equal(f.row("shell"), null);
    await f.click("Reset layout");
    assert.ok(f.row("shell"));
    assert.ok(
      (await f.store.read(f.scope)).informationLayout!.widgets.every(
        (widget) => widget.visible,
      ),
    );
  } finally {
    await f.close();
  }
});

test("actual add controls create independent Board placements without deleting removed bodies or forging bindings", async () => {
  const f = await fixture();
  try {
    await f.click("Customize information");
    await f.click("Add component");
    await f.click("Add component");
    const boards = (
      await f.store.read(f.scope)
    ).informationLayout!.widgets.filter((widget) => widget.type === "board");
    assert.equal(boards.length, 3);
    assert.equal(
      new Set(boards.map((widget) => widget.config.instanceKey)).size,
      3,
    );
    assert.ok(boards.every((widget) => widget.binding.kind === "owner"));
    const body = document.querySelector(`[data-widget-id="${boards[1]!.id}"]`)!;
    await f.click("Remove placement · Board", body);
    assert.equal(
      (await f.store.read(f.scope)).informationLayout!.widgets.filter(
        (widget) => widget.type === "board",
      ).length,
      2,
    );
    assert.ok(
      f.updates.every(
        (request) => !JSON.stringify(request).includes('"binding"'),
      ),
    );
  } finally {
    await f.close();
  }
});

test("conflicts retain exact edit and require explicit reapply; unknown writes are read before any repeat", async () => {
  const f = await fixture();
  try {
    await f.click("Customize information");
    f.fail("conflict");
    await f.click("Hide", f.row("triggers"));
    assert.match(document.body.textContent!, /layout changed/);
    assert.equal(f.updates.length, 1);
    assert.equal((await f.store.read(f.scope)).informationLayout, undefined);
    await f.click("Reapply edit");
    assert.equal(f.updates.length, 2);
    assert.equal(
      (await f.store.read(f.scope)).informationLayout!.widgets.find(
        (widget) => widget.type === "triggers",
      )!.visible,
      false,
    );
    f.fail("unknown");
    await f.click("Hide", f.row("shell"));
    assert.match(document.body.textContent!, /write outcome is unknown/);
    const reapply = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Reapply edit")!;
    assert.equal(reapply.disabled, true);
    const count = f.updates.length;
    await f.click("Read current layout");
    assert.equal(
      f.updates.length,
      count,
      "read-only reconciliation never repeats a write",
    );
    assert.equal(
      (await f.store.read(f.scope)).informationLayout!.widgets.find(
        (widget) => widget.type === "shell",
      )!.visible,
      false,
    );
    await f.click("Discard edit");
    assert.doesNotMatch(document.body.textContent!, /Retained edit/);
  } finally {
    await f.close();
  }
});

test("actual Room layout uses its live member source and an empty Room does not invent one", async () => {
  const f = await fixture("room");
  try {
    assert.match(document.body.textContent!, /Synthetic timer/);
    await f.click("Customize information");
    const member = document.querySelector<HTMLSelectElement>(
      '[aria-label="Source member"]',
    )!;
    assert.equal(member.value, "member");
    f.clearMembers();
    await f.click("Refresh information");
    assert.equal(member.value, "");
    assert.doesNotMatch(document.body.textContent!, /Synthetic timer/);
    const add = document.querySelector<HTMLSelectElement>(
      '[aria-label="Component"]',
    )!;
    await f.change(add, "triggers");
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((entry) => entry.textContent === "Add component")!;
    assert.equal(button.disabled, true);
    assert.ok(document.querySelector("#asking-attention"));
  } finally {
    await f.close();
  }
});

test("retained conflict and in-flight edits survive closing/reopening without an automatic second write", async () => {
  const f = await fixture();
  try {
    await f.click("Customize information");
    f.fail("conflict");
    await f.click("Hide", f.row("triggers"));
    await f.hide();
    await f.render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.match(document.body.textContent!, /layout changed/);
    assert.equal(f.updates.length, 1);
    await f.click("Reapply edit");
    assert.equal(f.updates.length, 2);
    await f.click("Customize information");
    const release = f.hold();
    await act(async () =>
      f
        .row("shell")
        .querySelector<HTMLButtonElement>(
          ".information-widget-actions button:nth-child(3)",
        )!
        .click(),
    );
    await f.hide();
    await f.render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.match(document.body.textContent!, /Saving the retained edit/);
    assert.equal(f.updates.length, 3);
    const reapply = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Reapply edit")!;
    assert.equal(reapply.disabled, true);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.doesNotMatch(document.body.textContent!, /Retained edit/);
    assert.equal(
      f.updates.length,
      3,
      "reopening never repeats the pending write",
    );
    assert.equal(
      (await f.store.read(f.scope)).informationLayout!.widgets.find(
        (widget) => widget.type === "shell",
      )!.visible,
      false,
    );
  } finally {
    await f.close();
  }
});

test("transcript deltas do not reread the native information layout when owner and facts are unchanged", async () => {
  const f = await fixture();
  try {
    const reads = f.readCount();
    for (let delta = 1; delta <= 30; delta++) await f.render(delta);
    assert.equal(f.readCount(), reads);
    assert.equal(f.updates.length, 0);
    assert.match(document.body.textContent!, /Synthetic transcript delta 30/);
  } finally {
    await f.close();
  }
});

test("a pre-write read cannot clear an unknown-write error or authorize reapply after settling late", async () => {
  const f = await fixture();
  try {
    await f.click("Customize information");
    const releaseRead = f.holdRead();
    await f.click("Refresh information");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    f.fail("unknown");
    await f.click("Hide", f.row("triggers"));
    assert.match(document.body.textContent!, /write outcome is unknown/);
    const reapply = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Reapply edit",
      )!;
    assert.equal(reapply().disabled, true);
    await act(async () => {
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(document.body.textContent!, /write outcome is unknown/);
    assert.match(document.body.textContent!, /Synthetic lost reply/);
    assert.equal(
      reapply().disabled,
      true,
      "only a read started after the unknown outcome may enable deliberate reapply",
    );
    assert.equal(f.updates.length, 1);
    await f.click("Read current layout");
    assert.equal(reapply().disabled, false);
    assert.equal(f.updates.length, 1);
    await f.click("Discard edit");
  } finally {
    await f.close();
  }
});

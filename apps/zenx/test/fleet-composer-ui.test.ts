import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import type { FleetProductApi } from "../src/renderer/src/FleetComposerSurface.js";
import type {
  FleetTargetCatalog,
  FleetThreadLocator,
} from "../src/main/fleet-product.js";

const bootstrap = new JSDOM('<div id="root"></div>', {
  url: "https://zenx.local/",
});
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { FleetComposerSurface } =
  await import("../src/renderer/src/FleetComposerSurface.js");

const machines = ["a", "b"].map((id) => ({
  id,
  label: `Machine ${id.toUpperCase()}`,
  description: `${id} work only`,
  transport: "https" as const,
  endpoint: `https://${id}.example:9443`,
  hostId: `host-${id}`,
  access: "control" as const,
}));
const catalog = (id: string): FleetTargetCatalog => ({
  machine: {
    id,
    key: `key-${id}`,
    hostId: `host-${id}`,
    label: `Machine ${id.toUpperCase()}`,
    description: `${id} work only`,
    access: "control",
    shellEnabled: false,
  },
  workspaces: [{ id: `work-${id}`, label: `Workspace ${id.toUpperCase()}` }],
  models: [
    {
      id: `${id}::model`,
      label: `Model ${id.toUpperCase()}`,
      isDefault: true,
      efforts: [],
      defaultEffort: null,
    },
  ],
});

async function mount(overrides: Partial<FleetProductApi> = {}) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  const creates: Parameters<FleetProductApi["createThread"]>[0][] = [];
  const sends: Parameters<FleetProductApi["sendThread"]>[0][] = [];
  const reads: FleetThreadLocator[] = [];
  const notices: string[] = [];
  const api: FleetProductApi = {
    status: async () => ({
      revision: 1,
      config: { version: 1, devices: machines },
      host: { hostId: "local", enabled: false, clients: [] },
    }),
    save: async () => {},
    pair: async () => {},
    remove: async () => {},
    test: async () => {},
    invoke: async () => {},
    hostPair: async () => ({ hostId: "local", code: "fixture" }),
    revoke: async () => {},
    catalog: async (id) => catalog(id),
    listThreads: async () => ({ threads: [], truncated: false }),
    createThread: async (input) => {
      creates.push(input);
      return {
        deviceId: input.deviceId,
        deviceKey: input.deviceKey,
        hostId: `host-${input.deviceId}`,
        workspace: input.workspace,
        threadId: "same-thread-id",
      };
    },
    sendThread: async (input) => {
      sends.push(input);
      return { turnId: "turn" };
    },
    readThread: async (locator) => {
      reads.push(locator);
      return {
        items: [
          {
            itemId: "reply",
            type: "agent_message",
            text: `${locator.deviceId} remote reply`,
          },
        ],
      };
    },
    threadStatus: async () => ({ status: "idle" }),
    ...overrides,
  };
  Object.defineProperty(dom.window, "zenx", { value: { fleet: api } });
  const root = createRoot(document.getElementById("root")!);
  function Host() {
    const [text, setText] = useState("Original task");
    return React.createElement(FleetComposerSurface, {
      text,
      onTextChange: setText,
      onNotice: (notice) => notices.push(notice),
      children: React.createElement(
        "div",
        { "data-local": "true" },
        `Local composer: ${text}`,
      ),
    });
  }
  await act(async () => root.render(React.createElement(Host)));
  const button = (label: string) => {
    const value = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.textContent?.trim() === label);
    assert.ok(value, label);
    return value;
  };
  const select = (label: string) => {
    const value = [...document.querySelectorAll("label")]
      .find((node) => node.querySelector("span")?.textContent?.trim() === label)
      ?.querySelector<HTMLButtonElement>("button.ui-select");
    assert.ok(value, label);
    return value;
  };
  const choose = async (label: string, value: string) => {
    const trigger = select(label);
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((node) => node.dataset.value === value);
    assert.ok(option, value);
    await act(async () => {
      option.focus();
      option.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await Promise.resolve();
    });
  const fill = async (value: string) =>
    act(async () => {
      const field = document.querySelector("textarea")!;
      assert.ok(field);
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
  };
  return {
    dom,
    root,
    api,
    creates,
    sends,
    reads,
    notices,
    select,
    choose,
    button,
    click,
    fill,
    close,
  };
}

test("New Thread defaults local; selected machine owns catalog/create/send/read and becomes locked", async () => {
  const view = await mount();
  try {
    assert.match(
      document.body.textContent ?? "",
      /Local composer: Original task/u,
    );
    assert.equal(view.creates.length, 0);
    await view.choose("Machine", "b");
    assert.equal(document.querySelector("textarea")!.value, "Original task");
    assert.equal(
      view.select("Model for new Threads").dataset.value,
      "b::model",
    );
    assert.doesNotMatch(document.body.textContent ?? "", /Model A/u);
    await view.click("Start on selected machine");
    assert.deepEqual(view.creates, [
      {
        deviceId: "b",
        deviceKey: "key-b",
        workspace: "work-b",
        model: "b::model",
      },
    ]);
    assert.equal(view.sends[0]!.locator.hostId, "host-b");
    assert.equal(view.sends[0]!.locator.threadId, "same-thread-id");
    assert.equal(view.sends[0]!.text, "Original task");
    assert.ok(view.reads.every((locator) => locator.deviceId === "b"));
    assert.equal(view.select("Machine").disabled, true);
    assert.match(document.body.textContent ?? "", /b remote reply/u);
    assert.equal(document.querySelector("textarea")!.value, "");
  } finally {
    await view.close();
  }
});

test("a late machine catalog cannot overwrite a newer target and switching preserves text", async () => {
  let resolveA!: (value: FleetTargetCatalog) => void;
  const pendingA = new Promise<FleetTargetCatalog>((resolve) => {
    resolveA = resolve;
  });
  const view = await mount({
    catalog: async (id) => (id === "a" ? pendingA : catalog(id)),
  });
  try {
    await view.choose("Machine", "a");
    await view.choose("Machine", "b");
    await act(async () => resolveA(catalog("a")));
    assert.equal(
      view.select("Model for new Threads").dataset.value,
      "b::model",
    );
    assert.equal(view.select("Target workspace").dataset.value, "work-b");
    await view.choose("Machine", "local");
    assert.match(
      document.body.textContent ?? "",
      /Local composer: Original task/u,
    );
    assert.equal(view.creates.length, 0);
  } finally {
    await view.close();
  }
});

test("same-loop Start is single-flight and an edit-away-and-back draft is not cleared by an old send", async () => {
  let resolveSend!: (value: unknown) => void;
  const pendingSend = new Promise<unknown>((resolve) => {
    resolveSend = resolve;
  });
  const view = await mount({
    sendThread: async (input) => {
      view.sends.push(input);
      return await pendingSend;
    },
  });
  try {
    await view.choose("Machine", "a");
    await act(async () => {
      const start = view.button("Start on selected machine");
      start.click();
      start.click();
      await Promise.resolve();
    });
    assert.equal(view.creates.length, 1);
    await view.fill("Different task");
    await view.fill("Original task");
    await act(async () => resolveSend({ turnId: "turn" }));
    assert.equal(document.querySelector("textarea")!.value, "Original task");
    assert.equal(view.sends.length, 1);
  } finally {
    await view.close();
  }
});

test("failed remote catalog leaves the local path untouched and can reload without sending", async () => {
  let failing = true;
  const view = await mount({
    catalog: async (id) => {
      if (failing) throw new Error("Remote grant revoked");
      return catalog(id);
    },
  });
  try {
    await view.choose("Machine", "a");
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /grant revoked.*no local machine was substituted/su,
    );
    assert.equal(view.creates.length, 0);
    assert.equal(document.querySelector('[data-local="true"]'), null);
    failing = false;
    await view.click("Reload target catalog");
    assert.equal(
      view.select("Model for new Threads").dataset.value,
      "a::model",
    );
    assert.equal(document.querySelector("textarea")!.value, "Original task");
    assert.equal(view.sends.length, 0);
  } finally {
    await view.close();
  }
});

test("SSH canonical message content stays readable without raw metadata or opaque reasoning", async () => {
  const view = await mount({
    readThread: async () => ({
      items: [
        {
          itemId: "meta",
          type: "thread_metadata",
          item: {
            type: "thread_metadata",
            cwd: "raw-metadata-should-not-dominate",
          },
        },
        {
          itemId: "user",
          type: "user_message",
          item: {
            type: "user_message",
            content: [
              { type: "text", text: "Multimodal text on target" },
              { type: "image", path: "/never-open-locally.png" },
            ],
          },
        },
        {
          itemId: "opaque",
          type: "reasoning",
          item: {
            type: "reasoning",
            contentVisibility: "opaque",
            reasoningContent: "opaque-do-not-display",
          },
        },
        {
          itemId: "tool",
          type: "tool_call",
          item: {
            type: "tool_call",
            name: "target-tool",
            arguments: { command: "fixture command" },
          },
        },
        {
          itemId: "reply",
          type: "agent_message",
          item: { type: "agent_message", text: "Target reply" },
        },
      ],
    }),
  });
  try {
    await view.choose("Machine", "b");
    await view.click("Start on selected machine");
    assert.match(
      document.body.textContent ?? "",
      /Multimodal text on target.*Remote image attachment.*Target reply/su,
    );
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /raw-metadata-should-not-dominate|opaque-do-not-display|never-open-locally/u,
    );
    assert.equal(document.querySelector("img"), null);
    assert.equal(
      document.querySelectorAll(".fleet-remote-history [style]").length,
      0,
    );
    const detail = [...document.querySelectorAll("details")].find(
      (entry) => entry.querySelector("summary")?.textContent === "target-tool",
    );
    assert.equal(detail?.open, false);
    assert.match(detail?.textContent ?? "", /target-tool.*fixture command/su);
  } finally {
    await view.close();
  }
});

test("revoked active reads stop automatic polling; acknowledged messages do not become uncertain retries", async () => {
  let revoked = false;
  let tick: (() => void) | undefined;
  let cleared = false;
  const view = await mount({
    threadStatus: async () => ({ status: "active" }),
    readThread: async () => {
      if (revoked) throw new Error("Remote grant revoked");
      return {
        items: [
          { id: "reply", type: "agent_message", text: "Accepted target reply" },
        ],
      };
    },
  });
  view.dom.window.setInterval = ((handler: () => void) => {
    tick = handler;
    return 99;
  }) as typeof view.dom.window.setInterval;
  view.dom.window.clearInterval = (() => {
    cleared = true;
  }) as typeof view.dom.window.clearInterval;
  try {
    await view.choose("Machine", "b");
    await view.click("Start on selected machine");
    assert.ok(tick);
    await view.fill("Preserved later task");
    revoked = true;
    await act(async () => {
      tick!();
      await Promise.resolve();
    });
    assert.equal(cleared, true);
    assert.match(
      document.body.textContent ?? "",
      /Unavailable.*stale.*Accepted target reply/su,
    );
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /grant revoked/u,
    );
    assert.equal(
      document.querySelector("textarea")!.value,
      "Preserved later task",
    );
    await view.click("Refresh remote Thread");
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Outcome needs inspection/u,
    );
    assert.equal(view.sends.length, 1);
  } finally {
    await view.close();
  }
});

import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  IsolatedPluginSurface,
  type PluginUiSdkV1,
} from "../src/renderer/src/plugin-ui-host.js";

type Reply = {
  type: string;
  requestId?: string;
  value?: unknown;
  message?: string;
  html?: string;
};
type Operation =
  | "commands.execute"
  | "navigation.navigate"
  | "interaction.begin"
  | "interaction.end";

/** Synthetic browser activation only; no native commands, network or model calls. */
async function fixture() {
  const dom = new JSDOM('<input id="composer"><div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const priorNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  let activated = false;
  Object.defineProperty(dom.window.navigator, "userActivation", {
    configurable: true,
    value: {
      get isActive() {
        return activated;
      },
    },
  });
  const priorNow = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 1000;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  const calls: Array<{ operation: string; id: string; input?: unknown }> = [];
  const replies: Reply[] = [];
  const sdk: PluginUiSdkV1 = {
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: {},
    handles: { read: async () => null },
    commands: {
      execute: async (id, input) => {
        calls.push({ operation: "commands.execute", id, input });
        return { confirmed: true };
      },
    },
    navigation: {
      navigate: (route) => {
        calls.push({
          operation: "navigation.navigate",
          id: "route",
          input: route,
        });
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  const render = async (scope: string) => {
    await act(async () => {
      root.render(
        React.createElement(IsolatedPluginSurface, {
          bundleHtml: "<button>Synthetic Board action</button>",
          exportName: "board",
          sdk,
          requireUserActivationFor: ["event", "draft"],
          interactionScope: scope,
        }),
      );
    });
  };
  await render("thread:a:document:1");
  const frame = document.querySelector("iframe")!;
  frame.contentWindow!.postMessage = (message: Reply) => {
    replies.push(message);
  };
  await act(async () => {
    frame.dispatchEvent(new dom.window.Event("load"));
  });
  const html = replies.find((message) => message.html)?.html;
  assert.ok(html, "Host initialized the isolated document");
  const channel = JSON.parse(
    html.match(/const init=(.*?);const deepFreeze/s)![1]!,
  ).channel as string;
  let gestureSequence = 0;
  const nonce = "synthetic-private-bootstrap-witness";
  window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: { channel, type: "zenx-plugin-ui:gesture-register", nonce },
    }),
  );
  let sequence = 0;
  const request = async (
    operation: Operation,
    id: string,
    input?: unknown,
    interactionId?: unknown,
  ) => {
    const requestId = String(++sequence);
    await act(async () => {
      window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            channel,
            type: "zenx-plugin-ui:request",
            requestId,
            operation,
            id,
            input,
            interactionId,
          },
        }),
      );
    });
    const reply = replies.find((message) => message.requestId === requestId);
    assert.ok(reply, "Host returned an explicit success or rejection");
    return reply;
  };
  return {
    calls,
    frame,
    render,
    request,
    activate(value: boolean, focused = true) {
      activated = value;
      if (value)
        window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            source: frame.contentWindow,
            data: {
              channel,
              type: "zenx-plugin-ui:gesture",
              nonce,
              sequence: ++gestureSequence,
            },
          }),
        );
      else now += 6_000;
      if (focused) frame.focus();
      else document.getElementById("composer")!.focus();
    },
    focusWithoutGesture() {
      activated = true;
      frame.focus();
    },
    forgeGesture() {
      window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            channel,
            type: "zenx-plugin-ui:gesture",
            nonce: "page-script-forgery",
            sequence: 9999,
          },
        }),
      );
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    async begin() {
      this.activate(true);
      const reply = await request("interaction.begin", "interaction");
      assert.equal(reply.type, "zenx-plugin-ui:result");
      assert.equal(typeof reply.value, "string");
      return reply.value as string;
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      if (priorNow) Object.defineProperty(performance, "now", priorNow);
      else Reflect.deleteProperty(performance, "now");
      if (priorNavigator)
        Object.defineProperty(globalThis, "navigator", priorNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    },
  };
}

function rejected(reply: Reply) {
  assert.equal(reply.type, "zenx-plugin-ui:error");
  assert.match(reply.message ?? "", /click|key|interaction|expired/i);
}

test("isolated Board on-load code cannot run events, replace drafts or navigate", async () => {
  const ui = await fixture();
  try {
    ui.focusWithoutGesture();
    ui.forgeGesture();
    rejected(
      await ui.request("commands.execute", "event", { eventId: "send" }),
    );
    rejected(
      await ui.request("commands.execute", "draft", { answer: "overwrite" }),
    );
    rejected(
      await ui.request("navigation.navigate", "route", "/threads/other"),
    );
    assert.deepEqual(ui.calls, []);
  } finally {
    await ui.close();
  }
});

test("isolated Board scope requires both current browser activation and frame focus", async () => {
  const ui = await fixture();
  try {
    ui.activate(true, false);
    rejected(await ui.request("interaction.begin", "interaction"));
    ui.activate(false, true);
    rejected(await ui.request("interaction.begin", "interaction"));
    await ui.begin();
    assert.deepEqual(ui.calls, []);
  } finally {
    await ui.close();
  }
});

test("a focused direct gesture permits Board edits, events and navigation without another prompt", async () => {
  const ui = await fixture();
  try {
    ui.activate(true);
    for (const [operation, id, input] of [
      ["commands.execute", "draft", { answer: "user edit" }],
      ["commands.execute", "event", { eventId: "send" }],
      ["navigation.navigate", "route", "/threads/a"],
    ] as const) {
      assert.equal(
        (await ui.request(operation, id, input)).type,
        "zenx-plugin-ui:result",
      );
    }
    assert.equal(ui.calls.length, 3);
  } finally {
    await ui.close();
  }
});

test("a scoped async script, composed message and navigation survive transient activation expiry", async () => {
  const ui = await fixture();
  try {
    const token = await ui.begin();
    assert.equal(
      (
        await ui.request(
          "commands.execute",
          "event",
          { eventId: "check" },
          token,
        )
      ).type,
      "zenx-plugin-ui:result",
    );
    // No second gesture or artificial browser activation after async work.
    ui.advance(6000);
    ui.activate(false, false);
    assert.equal(
      (
        await ui.request(
          "commands.execute",
          "event",
          {
            eventId: "send",
            values: { answer: "assembled from confirmed script result" },
          },
          token,
        )
      ).type,
      "zenx-plugin-ui:result",
    );
    assert.equal(
      (await ui.request("navigation.navigate", "route", "/threads/a", token))
        .type,
      "zenx-plugin-ui:result",
    );
    await ui.request("interaction.end", token);
    assert.deepEqual(
      ui.calls.map((call) => [call.operation, call.id]),
      [
        ["commands.execute", "event"],
        ["commands.execute", "event"],
        ["navigation.navigate", "route"],
      ],
    );
  } finally {
    await ui.close();
  }
});

test("unknown, ended and malformed scoped tokens cannot borrow a fresh gesture", async () => {
  const ui = await fixture();
  try {
    const token = await ui.begin();
    await ui.request("interaction.end", token);
    ui.activate(true);
    for (const invalid of ["unknown", token, null, 123]) {
      rejected(
        await ui.request(
          "commands.execute",
          "event",
          { eventId: "send" },
          invalid,
        ),
      );
      rejected(
        await ui.request(
          "commands.execute",
          "draft",
          { answer: "changed" },
          invalid,
        ),
      );
      rejected(
        await ui.request(
          "navigation.navigate",
          "route",
          "/threads/other",
          invalid,
        ),
      );
    }
    assert.deepEqual(ui.calls, []);
  } finally {
    await ui.close();
  }
});

test("five-minute continuation expiry rejects the old token even during a new click", async () => {
  const ui = await fixture();
  try {
    const token = await ui.begin();
    ui.advance(5 * 60_000);
    ui.activate(true);
    rejected(
      await ui.request("commands.execute", "event", { eventId: "send" }, token),
    );
    rejected(
      await ui.request("navigation.navigate", "route", "/threads/other", token),
    );
    assert.deepEqual(ui.calls, []);
    const fresh = await ui.begin();
    assert.notEqual(fresh, token);
    assert.equal(
      (
        await ui.request(
          "commands.execute",
          "event",
          { eventId: "send" },
          fresh,
        )
      ).type,
      "zenx-plugin-ui:result",
    );
    assert.equal(ui.calls.length, 1);
  } finally {
    await ui.close();
  }
});

test("document replacement revokes scoped authority without remounting unchanged HTML", async () => {
  const ui = await fixture();
  try {
    const token = await ui.begin();
    await ui.render("thread:a:document:2");
    assert.equal(document.querySelector("iframe"), ui.frame);
    ui.activate(true);
    rejected(
      await ui.request("commands.execute", "event", { eventId: "send" }, token),
    );
    rejected(
      await ui.request("navigation.navigate", "route", "/threads/other", token),
    );
    assert.deepEqual(ui.calls, []);
  } finally {
    await ui.close();
  }
});

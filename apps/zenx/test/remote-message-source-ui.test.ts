import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { RemoteMessageSourceDialog } from "../src/renderer/src/RemoteMessageSourceDialog.js";
import type { FleetMessageSourceView } from "../src/main/fleet-settings.js";

const source: FleetMessageSourceView = {
  receipt: { threadId: "local-receiver", itemId: "received-item" },
  locator: {
    deviceId: "return-peer",
    deviceKey: "a".repeat(64),
    hostId: "remote-host",
    workspace: "exact-workspace",
    threadId: "exact-remote-thread",
  },
  history: {
    threadId: "exact-remote-thread",
    nextCursor: "older-page",
    items: [
      {
        id: "trigger-message",
        type: "host_message",
        source: "trigger",
        sourceId: "exact-trigger",
        text: "Trigger update",
      },
      {
        id: "long-message",
        type: "agent_message",
        text: "Truncated message",
        textTruncated: true,
      },
    ],
  },
};

for (const remote of [false, true]) {
  test(`nested ${remote ? "unbound remote" : "same-Host"} Thread source uses the conversation glyph without changing its route`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local",
    });
    const prior = { window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const calls: unknown[] = [];
    (window as any).zenx = {
      fleet: {
        sourceHistory: async (input: unknown) => {
          calls.push(input);
          return { threadId: "nested-thread", items: [], nextCursor: null };
        },
      },
      protocol: {
        request: async () => {
          assert.fail("A remote source must not navigate to a local Thread");
        },
      },
    };
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(
          React.createElement(RemoteMessageSourceDialog, {
            value: {
              ...source,
              history: {
                items: [
                  {
                    id: "nested-message",
                    type: "thread_message",
                    sender: {
                      ...(remote ? { deviceId: "unbound-peer" } : {}),
                      threadId: "nested-thread",
                      threadName: remote
                        ? "Unbound peer"
                        : "Follow-up research",
                    },
                    text: "Source context",
                  },
                ],
              },
            },
            onClose() {},
          }),
        ),
      );
      const button = document.querySelector<HTMLButtonElement>(
        ".thread-message-sender",
      )!;
      assert.equal(
        button.textContent,
        remote ? "Remote: Unbound peer" : "From Follow-up research",
      );
      assert.equal(
        button.querySelector("svg")!.getAttribute("data-icon"),
        "conversation",
      );
      await act(async () => button.click());
      if (remote) {
        assert.match(
          document.querySelector('[role="alert"]')!.textContent!,
          /no verified return route/,
        );
        assert.deepEqual(calls, []);
      } else {
        assert.deepEqual(calls, [
          {
            receipt: source.receipt,
            locator: { ...source.locator, threadId: "nested-thread" },
          },
        ]);
        assert.equal(document.querySelector('[role="alert"]'), null);
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, prior);
    }
  });
}

test("source dialog reads exact remote Trigger settings, older history and full original text without local navigation or writes", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: unknown[] = [];
  (window as any).zenx = {
    fleet: {
      triggerSource: async (input: unknown) => {
        calls.push(["trigger", input]);
        return {
          trigger: {
            id: "exact-trigger",
            label: "Actual remote settings",
            prompt: "Host-owned prompt",
            programConfigured: true,
          },
        };
      },
      sourceHistory: async (input: any) => {
        calls.push(["history", input]);
        if (input.itemId) {
          const raw = JSON.stringify({
            id: input.itemId,
            text: "Complete source original text",
          });
          return {
            content: raw,
            offset: 0,
            totalLength: raw.length,
            nextCursor: null,
          };
        }
        return {
          threadId: source.locator.threadId,
          items: [
            {
              id: "older",
              type: "agent_message",
              text: "Older original message",
            },
          ],
          nextCursor: null,
        };
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  const click = async (text: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    assert.ok(button, text);
    await act(async () => button.click());
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(RemoteMessageSourceDialog, {
          value: source,
          onClose() {},
        }),
      ),
    );
    assert.match(
      document.body.textContent!,
      /remote-host.*exact-workspace.*exact-remote-thread/,
    );
    await click("Trigger");
    assert.match(document.body.textContent!, /Actual remote settings/);
    assert.match(
      document.body.textContent!,
      /Program commands and environment values are hidden/,
    );
    await click("Back to source conversation");
    await click("Load older messages");
    assert.match(document.body.textContent!, /Older original message/);
    assert.match(document.body.textContent!, /Truncated message/);
    await click("Read full message");
    assert.match(document.body.textContent!, /Complete source original text/);
    assert.deepEqual(calls, [
      [
        "trigger",
        {
          receipt: source.receipt,
          locator: source.locator,
          triggerId: "exact-trigger",
        },
      ],
      [
        "history",
        {
          receipt: source.receipt,
          locator: source.locator,
          cursor: "older-page",
        },
      ],
      [
        "history",
        {
          receipt: source.receipt,
          locator: source.locator,
          itemId: "long-message",
        },
      ],
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

test("newer source selection retires delayed remote settings and unbound peers never open a same-ID local Thread", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let settle!: (value: unknown) => void;
  let reads = 0;
  (window as any).zenx = {
    fleet: {
      triggerSource: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      sourceHistory: async () => {
        reads++;
        throw new Error("Must not resolve an unbound peer");
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(RemoteMessageSourceDialog, {
          value: source,
          onClose() {},
        }),
      ),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.trim() === "Trigger")!
        .click(),
    );
    const newer: FleetMessageSourceView = {
      ...source,
      locator: { ...source.locator, threadId: "newer-remote-thread" },
      history: {
        items: [
          {
            id: "remote-unbound",
            type: "thread_message",
            sender: {
              deviceId: "incoming-not-outgoing",
              threadId: "same-id-local",
              threadName: "Unbound peer",
              callId: "call",
              toolCallId: "tool",
            },
            text: "Agent-only source context",
          },
        ],
      },
    };
    await act(async () =>
      root.render(
        React.createElement(RemoteMessageSourceDialog, {
          value: newer,
          onClose() {},
        }),
      ),
    );
    await act(async () =>
      settle({
        trigger: { id: "stale", label: "Stale settings must not appear" },
      }),
    );
    assert.ok(!document.body.textContent!.includes("Stale settings"));
    assert.match(document.body.textContent!, /newer-remote-thread/);
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.includes("Unbound peer"))!
        .click(),
    );
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /no verified return route/,
    );
    assert.equal(reads, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

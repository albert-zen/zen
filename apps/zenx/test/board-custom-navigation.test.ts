import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BoardSurface } from "../src/renderer/src/board-ui.js";
import type { BoardSnapshot } from "../../../packages/zenx-board-plugin/src/board.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

type Reply = {
  type: string;
  requestId?: string;
  message?: string;
  value?: unknown;
  html?: string;
  interactionScope?: string;
};

/** Production BoardSurface and iframe bridge; only the input witness/Host port are synthetic. */
async function fixture() {
  const dom = new JSDOM('<input id="composer"><div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const priorNow = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 1000;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  const admission = crypto.randomUUID();
  const owner = (id: string) => ({ kind: "thread" as const, threadId: id });
  let snapshot: BoardSnapshot = {
    revision: 1,
    draftRevision: 0,
    pinned: false,
    values: {},
    document: {
      id: "navigation",
      title: "Navigation",
      summary: "Synthetic",
      owner: owner("nav-a"),
      blocks: [],
      events: [],
      html: "<button>Navigate</button>",
    },
  };
  const hostCalls: Array<Record<string, unknown>> = [];
  const appRoutes: string[] = [];
  let failNavigation = false;
  const sdk = (): PluginUiSdkV1 => ({
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: { owner: snapshot.document.owner, admissionId: admission },
    handles: { read: async () => null },
    navigation: {
      navigate: (route) => {
        appRoutes.push(route);
      },
    },
    commands: {
      execute: async (_id, input) => {
        const request = input as Record<string, unknown>;
        if (request.operation === "read") return structuredClone(snapshot);
        hostCalls.push(structuredClone(request));
        if (failNavigation)
          throw new Error("Exact Browser unavailable", {
            cause: new Error("Synthetic current-owner failure"),
          });
        return {
          snapshot: structuredClone(snapshot),
          outcomes: [{ kind: "navigate" }],
          navigation: [request.target],
        };
      },
    },
  });
  let frame: HTMLIFrameElement;
  const replies: Reply[] = [];
  let channel = "";
  let scope = "";
  let sequence = 0;
  let gestureSequence = 0;
  const nonce = "synthetic-private-bootstrap-witness";
  const post = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, ...data },
      }),
    );
  const render = async () => {
    await act(async () =>
      root.render(React.createElement(BoardSurface, { sdk: sdk() })),
    );
    const nextFrame = document.querySelector<HTMLIFrameElement>("iframe")!;
    assert.ok(nextFrame);
    if (nextFrame !== frame) {
      frame = nextFrame;
      frame.contentWindow!.postMessage = (reply: Reply) => {
        replies.push(reply);
        if (reply.interactionScope) scope = reply.interactionScope;
      };
      await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
      const init = JSON.parse(
        replies
          .filter((reply) => reply.html)
          .at(-1)!
          .html!.match(/const init=(.*?);const deepFreeze/s)![1]!,
      );
      channel = init.channel;
      scope = init.interactionScope;
      post({ type: "zenx-plugin-ui:gesture-register", nonce });
    }
  };
  await render();
  const request = async (
    operation: string,
    id: string,
    input?: unknown,
    interactionId?: unknown,
    interactionScope = scope,
  ) => {
    const requestId = String(++sequence);
    await act(async () =>
      post({
        type: "zenx-plugin-ui:request",
        requestId,
        operation,
        id,
        input,
        interactionId,
        interactionScope,
      }),
    );
    const reply = replies.find((reply) => reply.requestId === requestId);
    assert.ok(reply, "Bridge returns explicit result or rejection");
    return reply;
  };
  return {
    hostCalls,
    appRoutes,
    request,
    get scope() {
      return scope;
    },
    gesture() {
      post({
        type: "zenx-plugin-ui:gesture",
        nonce,
        sequence: ++gestureSequence,
        interactionScope: scope,
      });
      document.getElementById("composer")!.focus();
    },
    async begin() {
      this.gesture();
      return (await request("interaction.begin", "interaction"))
        .value as string;
    },
    async updateDocument() {
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".board-footer button")!
          .click(),
      );
    },
    async switchOwner() {
      snapshot = {
        ...snapshot,
        document: { ...snapshot.document, owner: owner("nav-b") },
      };
      await render();
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    fail() {
      failNavigation = true;
    },
    recover() {
      failNavigation = false;
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      if (priorNow) Object.defineProperty(performance, "now", priorNow);
      else Reflect.deleteProperty(performance, "now");
    },
  };
}

test("custom Board navigation uses exact Host URL/Browser targets, never App routes", async () => {
  const ui = await fixture();
  try {
    assert.equal(
      (
        await ui.request(
          "navigation.navigate",
          "route",
          "https://example.test/docs",
        )
      ).type,
      "zenx-plugin-ui:error",
    );
    assert.equal(
      (
        await ui.request("commands.execute", "navigate", {
          target: { kind: "browser", id: "exact-live-id" },
        })
      ).type,
      "zenx-plugin-ui:error",
    );
    const token = await ui.begin();
    ui.advance(6_000); // The callback's scope, not a still-live direct click, authorizes async effects.
    const url = "https://example.test/docs?q=exact#section";
    assert.equal(
      (await ui.request("navigation.navigate", "route", url, token)).type,
      "zenx-plugin-ui:result",
    );
    assert.deepEqual(ui.hostCalls[0], {
      operation: "navigate",
      owner: { kind: "thread", threadId: "nav-a" },
      revision: 1,
      target: { kind: "url", url },
    });
    assert.equal(
      (
        await ui.request(
          "commands.execute",
          "navigate",
          { target: { kind: "browser", id: "exact-live-id" } },
          token,
        )
      ).type,
      "zenx-plugin-ui:result",
    );
    assert.deepEqual(ui.hostCalls[1]?.target, {
      kind: "browser",
      id: "exact-live-id",
    });
    const rejected = await ui.request(
      "navigation.navigate",
      "route",
      "/settings/private",
      token,
    );
    assert.equal(rejected.type, "zenx-plugin-ui:error");
    assert.match(
      rejected.message ?? "",
      /absolute HTTP\(S\).*application routes/,
    );
    await ui.request("interaction.end", token);
    assert.equal(
      (await ui.request("navigation.navigate", "route", url, token)).type,
      "zenx-plugin-ui:error",
    );
    assert.equal(ui.hostCalls.length, 2);
    assert.deepEqual(ui.appRoutes, []);
    assert.ok(
      ui.hostCalls.every((call) => call.operation === "navigate"),
      "No model delivery or draft mutation",
    );
  } finally {
    await ui.close();
  }
});

test("custom Board navigation fences asynchronous scopes by document and current owner", async () => {
  const ui = await fixture();
  try {
    const token = await ui.begin();
    const oldScope = ui.scope;
    await ui.updateDocument();
    assert.notEqual(ui.scope, oldScope);
    assert.equal(
      (
        await ui.request(
          "navigation.navigate",
          "route",
          "https://example.test/old",
          token,
          oldScope,
        )
      ).type,
      "zenx-plugin-ui:error",
    );
    const newToken = await ui.begin();
    await ui.switchOwner();
    assert.equal(
      (
        await ui.request(
          "navigation.navigate",
          "route",
          "https://example.test/old-owner",
          newToken,
        )
      ).type,
      "zenx-plugin-ui:error",
    );
    const currentToken = await ui.begin();
    assert.equal(
      (
        await ui.request(
          "navigation.navigate",
          "route",
          "https://example.test/current",
          currentToken,
        )
      ).type,
      "zenx-plugin-ui:result",
    );
    assert.deepEqual(
      ui.hostCalls.map((call) => call.owner),
      [{ kind: "thread", threadId: "nav-b" }],
    );
    assert.deepEqual(ui.appRoutes, []);
  } finally {
    await ui.close();
  }
});

test("custom navigation exposes owner-local Host failures and clears recovered errors", async () => {
  const ui = await fixture();
  try {
    const token = await ui.begin();
    ui.fail();
    assert.equal(
      (
        await ui.request(
          "commands.execute",
          "navigate",
          { target: { kind: "browser", id: "retired" } },
          token,
        )
      ).type,
      "zenx-plugin-ui:error",
    );
    assert.match(
      document.querySelector(".board-error")?.textContent ?? "",
      /Exact Browser unavailable/,
    );
    assert.match(
      document.querySelector(".board-error pre")?.textContent ?? "",
      /Synthetic current-owner failure/,
    );
    ui.recover();
    await ui.request(
      "navigation.navigate",
      "route",
      "https://example.test/recovered",
      token,
    );
    assert.equal(document.querySelector(".board-error"), null);
    assert.deepEqual(ui.appRoutes, []);
  } finally {
    await ui.close();
  }
});

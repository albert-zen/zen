import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCommittedCallback } from "../src/renderer/src/use-committed-callback.js";
Object.assign(globalThis, { React });
const { AppConversationProviders } = await import("../src/renderer/src/App.js");
const { MessageForkContext } = await import("../src/renderer/src/ThreadView.js");
const { ShellTargetNavigationContext } = await import("../src/renderer/src/shell-target-navigation.js");
const { SideChatDraftContext, SubagentCreationModelsContext } = await import("../src/renderer/src/subagents-ui.js");
const { act, createElement } = React;

async function withDom(run: (root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost" });
  const previous = {
    document: globalThis.document, HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node, window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, window: dom.window, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try { await run(root); }
  finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: undefined });
    dom.window.close();
  }
}

test("real App provider stack keeps history consumers stable while handlers use latest committed authority", { timeout: 10000 }, async () => {
  await withDom(async (root) => {
    let renders = 0;
    const calls: string[] = [];
    let invoke: () => Promise<void> = async () => { throw new Error("Not mounted"); };
    const models: React.ComponentProps<typeof AppConversationProviders>["models"] = [];
    const Consumer = React.memo(function Consumer() {
      renders++;
      const fork = React.useContext(MessageForkContext)!;
      const shell = React.useContext(ShellTargetNavigationContext)!;
      React.useContext(SideChatDraftContext);
      React.useContext(SubagentCreationModelsContext);
      React.useLayoutEffect(() => {
        invoke = async () => {
          await fork({ sourceThreadId: "source", itemId: "item" }, { isCurrent: () => true, isVisible: () => true });
          await shell.open({ threadId: "source", taskId: "task" }, { isCurrent: () => true });
        };
      }, [fork, shell]);
      return createElement("span", null, "Historical message");
    });
    const render = (threadId: string, allowed: boolean) => root.render(
      createElement(AppConversationProviders, {
        models, modelCatalogError: null,
        fork: async () => {
          if (!allowed) throw new Error("Current permission denied");
          calls.push("fork:" + threadId);
        },
        source: async () => undefined,
        openSideChatDraft: async () => undefined,
        shellNavigation: {
          request: null,
          consumed: () => undefined,
          open: async () => { calls.push("shell:" + threadId); },
        },
        children: createElement(Consumer),
      }),
    );
    await act(async () => render("thread-a", true));
    const mountedRenders = renders;
    await act(async () => render("thread-a", true));
    assert.equal(renders, mountedRenders, "draft-only App callbacks must not broadcast to history");
    await act(async () => render("thread-b", true));
    assert.equal(renders, mountedRenders);
    await invoke();
    assert.deepEqual(calls, ["fork:thread-b", "shell:thread-b"]);
    await act(async () => render("thread-b", false));
    await assert.rejects(invoke, /Current permission denied/);
    assert.deepEqual(calls, ["fork:thread-b", "shell:thread-b"]);
    await act(async () => root.render(null));
    await assert.rejects(invoke, /UI action is no longer available/);
  });
});

test("an aborted render cannot publish its callback and an unmounted delegate cannot act", { timeout: 10000 }, async () => {
  await withDom(async (root) => {
    const calls: string[] = [];
    let invoke: () => void = () => { throw new Error("Not mounted"); };
    let release!: () => void;
    const suspended = new Promise<void>((resolve) => { release = resolve; });
    function Target({ label, suspend }: { label: string; suspend: boolean }) {
      const callback = useCommittedCallback(() => { calls.push(label); });
      React.useLayoutEffect(() => { invoke = callback; }, [callback]);
      if (suspend) throw suspended;
      return createElement("span", null, label);
    }
    const render = (label: string, suspend = false) => root.render(
      createElement(React.Suspense, { fallback: createElement("span", null, "Waiting") },
        createElement(Target, { label, suspend }),
      ),
    );
    await act(async () => render("committed"));
    await act(async () => React.startTransition(() => render("aborted", true)));
    invoke();
    assert.deepEqual(calls, ["committed"]);
    await act(async () => render("replacement"));
    await act(async () => { release(); await suspended; });
    invoke();
    assert.deepEqual(calls, ["committed", "replacement"]);
    await act(async () => root.render(null));
    assert.throws(invoke, /UI action is no longer available/);
  });
});

import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCommittedCallback } from "../src/renderer/src/use-committed-callback.js";
Object.assign(globalThis, { React });
const { AppConversationProviders } = await import("../src/renderer/src/App.js");
const { MessageForkContext, SideChatQuoteContext } =
  await import("../src/renderer/src/ThreadView.js");
const { ShellTargetNavigationContext } =
  await import("../src/renderer/src/shell-target-navigation.js");
const { SideChatDraftContext, SubagentCreationModelsContext } =
  await import("../src/renderer/src/subagents-ui.js");
const { act, createElement } = React;

async function withDom(run: (root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

test(
  "real App provider stack keeps history consumers stable while handlers use latest committed authority",
  { timeout: 10000 },
  async () => {
    await withDom(async (root) => {
      let renders = 0;
      const calls: string[] = [];
      let invoke: () => Promise<void> = async () => {
        throw new Error("Not mounted");
      };
      const models: React.ComponentProps<
        typeof AppConversationProviders
      >["models"] = [];
      const Consumer = React.memo(function Consumer() {
        renders++;
        const fork = React.useContext(MessageForkContext)!;
        const shell = React.useContext(ShellTargetNavigationContext)!;
        React.useContext(SideChatDraftContext);
        React.useContext(SubagentCreationModelsContext);
        React.useLayoutEffect(() => {
          invoke = async () => {
            await fork(
              { sourceThreadId: "source", itemId: "item" },
              { isCurrent: () => true, isVisible: () => true },
            );
            await shell.open(
              { threadId: "source", taskId: "task" },
              { isCurrent: () => true },
            );
          };
        }, [fork, shell]);
        return createElement("span", null, "Historical message");
      });
      const render = (threadId: string, allowed: boolean) =>
        root.render(
          createElement(AppConversationProviders, {
            models,
            modelCatalogError: null,
            fork: async () => {
              if (!allowed) throw new Error("Current permission denied");
              calls.push("fork:" + threadId);
            },
            source: async () => undefined,
            openSideChatDraft: async () => undefined,
            shellNavigation: {
              request: null,
              consumed: () => undefined,
              open: async () => {
                calls.push("shell:" + threadId);
              },
            },
            children: createElement(Consumer),
          }),
        );
      await act(async () => render("thread-a", true));
      const mountedRenders = renders;
      await act(async () => render("thread-a", true));
      assert.equal(
        renders,
        mountedRenders,
        "draft-only App callbacks must not broadcast to history",
      );
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
  },
);

test(
  "an aborted render cannot publish its callback and an unmounted delegate cannot act",
  { timeout: 10000 },
  async () => {
    await withDom(async (root) => {
      const calls: string[] = [];
      let invoke: () => void = () => {
        throw new Error("Not mounted");
      };
      let release!: () => void;
      const suspended = new Promise<void>((resolve) => {
        release = resolve;
      });
      function Target({ label, suspend }: { label: string; suspend: boolean }) {
        const callback = useCommittedCallback(() => {
          calls.push(label);
        });
        React.useLayoutEffect(() => {
          invoke = callback;
        }, [callback]);
        if (suspend) throw suspended;
        return createElement("span", null, label);
      }
      const render = (label: string, suspend = false) =>
        root.render(
          createElement(
            React.Suspense,
            { fallback: createElement("span", null, "Waiting") },
            createElement(Target, { label, suspend }),
          ),
        );
      await act(async () => render("committed"));
      await act(async () =>
        React.startTransition(() => render("aborted", true)),
      );
      invoke();
      assert.deepEqual(calls, ["committed"]);
      await act(async () => render("replacement"));
      await act(async () => {
        release();
        await suspended;
      });
      invoke();
      assert.deepEqual(calls, ["committed", "replacement"]);
      await act(async () => root.render(null));
      assert.throws(invoke, /UI action is no longer available/);
    });
  },
);

test("semantic shell, model, quote availability and focus changes still reach consumers", { timeout: 10000 }, async () => {
  await withDom(async (root) => {
    const initialModels: React.ComponentProps<typeof AppConversationProviders>["models"] = [];
    let latest: {
      request: React.ContextType<typeof ShellTargetNavigationContext>;
      model: React.ContextType<typeof SubagentCreationModelsContext>;
      quote: React.ContextType<typeof SideChatQuoteContext>;
    } | undefined;
    let renders = 0;
    const Consumer = React.memo(function Consumer() {
      renders++;
      const request = React.useContext(ShellTargetNavigationContext);
      const model = React.useContext(SubagentCreationModelsContext);
      const quote = React.useContext(SideChatQuoteContext);
      React.useLayoutEffect(() => { latest = { request, model, quote }; }, [request, model, quote]);
      return null;
    });
    const state: {
      request: NonNullable<React.ContextType<typeof ShellTargetNavigationContext>>["request"];
      models: typeof initialModels;
      error: string | null;
      canAdd: boolean;
      focus: { composerId: string; sequence: number } | undefined;
    } = { request: null, models: initialModels, error: null, canAdd: false, focus: undefined };
    const render = () => root.render(createElement(AppConversationProviders, {
      models: state.models, modelCatalogError: state.error,
      fork: async () => undefined, source: async () => undefined,
      openSideChatDraft: async () => undefined,
      addToSideChat: state.canAdd ? () => undefined : undefined,
      composerFocus: state.focus,
      shellNavigation: {
        request: state.request, consumed: () => undefined, open: async () => undefined,
      },
      children: createElement(Consumer),
    }));
    await act(async () => render());
    assert.equal(latest?.request?.request, null);
    assert.equal(latest?.quote.add, undefined);
    const initialRenders = renders;
    await act(async () => render());
    assert.equal(renders, initialRenders);
    state.request = { threadId: "source", taskId: "task", ownerKey: "thread:source", requestId: 1 };
    state.models = [...initialModels];
    state.error = "Synthetic catalog update";
    state.canAdd = true;
    state.focus = { composerId: "current-composer", sequence: 1 };
    await act(async () => render());
    assert.ok(renders > initialRenders);
    assert.equal(latest?.request?.request, state.request);
    assert.equal(latest?.model.models, state.models);
    assert.equal(latest?.model.error, state.error);
    assert.equal(typeof latest?.quote.add, "function");
    assert.equal(latest?.quote.focus, state.focus);
    state.canAdd = false;
    state.request = null;
    state.focus = undefined;
    await act(async () => render());
    assert.equal(latest?.quote.add, undefined);
    assert.equal(latest?.request?.request, null);
    assert.equal(latest?.quote.focus, undefined);
  });
});

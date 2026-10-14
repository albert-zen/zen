import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadView,
  MessageForkContext,
} from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  runtimeThread,
  runtimeMessage,
} from "./fixtures/agent-runtime-data.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
import type { Thread } from "../src/protocol-client/index.js";
const { act, createElement } = React;
const noop = async () => undefined;

function fixture(): Thread {
  const thread = runtimeThread(
    [
      runtimeMessage("message-a", "First canonical answer"),
      runtimeMessage("message-b", "Later answer"),
    ],
    "interrupted",
    "source-thread",
  );
  return {
    ...thread,
    canonicalItems: nativeRecoveryForThread(thread).thread.items,
  };
}

async function mount(
  run: (
    render: (
      thread: Thread,
      fork: React.ContextType<typeof MessageForkContext>,
    ) => Promise<void>,
  ) => Promise<void>,
) {
  const prior = { window: globalThis.window, document: globalThis.document };
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(async (thread, fork) => {
      await act(async () =>
        root.render(
          createElement(
            MessageForkContext.Provider,
            { value: fork },
            createElement(ThreadView, {
              thread,
              approvals: [],
              composer: emptyComposerState(),
              onDraftChange: noop,
              onInterrupt: noop,
              onRespondToApproval: noop,
              onSubmit: noop,
            }),
          ),
        ),
      );
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior, { IS_REACT_ACT_ENVIRONMENT: undefined });
    dom.window.close();
  }
}

function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>(".message-fork")];
}

test("each canonical Agent message places Fork directly after Copy and binds exact source identities", async () => {
  await mount(async (render) => {
    const calls: unknown[] = [];
    await render(fixture(), async (target) => {
      calls.push(target);
    });
    assert.equal(buttons().length, 2);
    for (const button of buttons()) {
      assert.equal(button.previousElementSibling?.className, "message-copy");
      assert.equal(
        button.getAttribute("aria-label"),
        "Fork thread from this message",
      );
      assert.equal(button.title, "Fork thread from this message");
      await act(async () => button.focus());
      assert.equal(document.activeElement, button);
    }
    await act(async () => buttons()[0]!.click());
    assert.deepEqual(calls, [
      { sourceThreadId: "source-thread", itemId: "message-a" },
    ]);
  });
});

test("stream-only and wrong-thread or wrong-turn Items cannot become fork boundaries", async () => {
  await mount(async (render) => {
    const thread = fixture();
    const items = thread.canonicalItems!.filter(
      (item) => item.id !== "message-b",
    );
    await render({ ...thread, canonicalItems: items }, noop);
    assert.equal(buttons().length, 1);
    await render(
      {
        ...thread,
        canonicalItems: items.map((item) => ({
          ...item,
          threadId: "other-thread",
        })),
      },
      noop,
    );
    assert.equal(buttons().length, 0);
    await render(
      {
        ...thread,
        canonicalItems: items.map((item) =>
          item.type === "agent_message"
            ? {
                ...item,
                turnId: "wrong-turn",
              }
            : item,
        ),
      },
      noop,
    );
    assert.equal(buttons().length, 0);
  });
});

test("repeat clicks share the pending action and failures stay visible and retryable", async () => {
  await mount(async (render) => {
    let reject!: (error: Error) => void;
    let calls = 0;
    const pending = new Promise<void>((_resolve, no) => {
      reject = no;
    });
    await render(fixture(), async () => {
      calls++;
      await pending;
    });
    const button = buttons()[0]!;
    await act(async () => {
      button.click();
      button.click();
    });
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    await act(async () =>
      reject(new Error("The exact message is unavailable")),
    );
    assert.equal(button.disabled, false);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /exact message is unavailable/,
    );
  });
});

test("pending completion loses navigation ownership after switching threads", async () => {
  await mount(async (render) => {
    let isCurrent!: () => boolean;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const callback: NonNullable<
      React.ContextType<typeof MessageForkContext>
    > = async (_target, current) => {
      isCurrent = current.isCurrent;
      await pending;
    };
    await render(fixture(), callback);
    await act(async () => buttons()[0]!.click());
    assert.equal(isCurrent(), true);
    await render(
      { ...fixture(), id: "other-thread", canonicalItems: [] },
      callback,
    );
    assert.equal(isCurrent(), false);
    await act(async () => finish());
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
});

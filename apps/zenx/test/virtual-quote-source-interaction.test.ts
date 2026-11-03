import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import { queueScenario } from "./fixtures/agent-queue-data.js";
import {
  runtimeMessage,
  runtimeCommand,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";
import { referenceMessage } from "../src/renderer/src/reference-draft.js";
import { withSkillDraft } from "../src/renderer/src/skill-draft.js";
import type { CanonicalItem } from "../../../src/item.js";

const quote = {
  kind: "message" as const,
  name: "",
  threadId: "runtime-thread",
  id: "historical-5",
  cwd: "/workspace/zen",
  excerpt: "Exact old answer 5",
};
function history(reference = quote) {
  const thread = queueScenario(1);
  const turns = Array.from({ length: 100 }, (_, index) => ({
    ...runtimeThread(
      [runtimeMessage(`historical-${index}`, `Exact old answer ${index}`)],
      "completed",
    ).turns[0]!,
    id: `historical-turn-${index}`,
  }));
  const canonical: CanonicalItem[] = turns.map((turn, index) => ({
    type: "agent_message",
    id: `historical-${index}`,
    threadId: thread.id,
    turnId: turn.id,
    createdAt: "2026-11-03T00:00:00Z",
    text: `Exact old answer ${index}`,
  }));
  const payload = referenceMessage("Sent question", [reference], "sent-client");
  thread.turns[0]!.items.push({
    type: "userMessage",
    id: "sent-quote",
    clientId: "sent-client",
    content: [{ type: "text", text: payload, text_elements: [] }],
  });
  canonical.push({
    type: "user_message",
    id: "sent-quote",
    threadId: thread.id,
    turnId: thread.turns[0]!.id,
    createdAt: "2026-11-03T00:00:01Z",
    clientId: "sent-client",
    text: payload,
  });
  return {
    ...thread,
    turns: [...turns, ...thread.turns],
    canonicalItems: [
      ...canonical,
      ...thread.canonicalItems!.map((item) =>
        item.type === "user_message_queued"
          ? {
              ...item,
              input: [
                {
                  type: "text" as const,
                  text: referenceMessage(
                    "Queued question",
                    [reference],
                    item.clientId,
                  ),
                },
              ],
            }
          : item,
      ),
    ],
  };
}
function enableVirtualGeometry() {
  window.sessionStorage.setItem("zenx.experimental.virtualTranscript", "1");
  const proto = window.HTMLElement.prototype;
  const rect = (height: number) => ({
    top: 0,
    bottom: height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: 0,
    toJSON() {},
  });
  proto.getBoundingClientRect = function () {
    return rect(this.classList.contains("messages") ? 600 : 280);
  };
  // A small fixed-height controlled layout, not a browser geometry measurement.
  const tops = new WeakMap<HTMLElement, number>();
  let scrollCallbacks = 0;
  let callbackFailure: Error | null = null;
  const lastOffsets: string[] = [];
  const recordScroll = (node: HTMLElement, kind: string, offset: number) => {
    if (!node.classList.contains("messages")) return true;
    lastOffsets.push(
      `${kind}: requested=${offset}, old=${tops.get(node) ?? 0}, max=${node.scrollHeight - node.clientHeight}`,
    );
    if (lastOffsets.length > 12) lastOffsets.shift();
    if (++scrollCallbacks <= 1000) return true;
    callbackFailure ??= new Error(
      `Controlled virtual layout exceeded 1000 scroll callbacks:\n${lastOffsets.join("\n")}`,
    );
    return false;
  };
  Object.defineProperties(proto, {
    scrollTop: {
      configurable: true,
      get() {
        return tops.get(this) ?? 0;
      },
      set(value: number) {
        if (!recordScroll(this, "scrollTop", value)) return;
        tops.set(
          this,
          Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)),
        );
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages")
          ? 600
          : this.closest(".virtual-transcript-content")
            ? 280
            : 0;
      },
    },
    clientWidth: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ||
          this.closest(".virtual-transcript-content")
          ? 800
          : 0;
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages")
          ? 600
          : this.closest(".virtual-transcript-content")
            ? 280
            : 0;
      },
    },
    offsetWidth: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ||
          this.closest(".virtual-transcript-content")
          ? 800
          : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains("messages"))
          return this.closest(".virtual-transcript-content") ? 280 : 32;
        const region = [
          ...this.querySelectorAll<HTMLElement>(
            ".virtual-transcript-content div",
          ),
        ].find(
          (element) =>
            element.style.position === "relative" &&
            element.style.height.endsWith("px"),
        );
        return Math.max(
          600,
          (parseFloat(region?.style.height ?? "0") || 0) + 560,
        );
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ||
          this.closest(".virtual-transcript-content")
          ? 800
          : 0;
      },
    },
  });
  proto.scrollTo = function (options) {
    if (
      !recordScroll(
        this,
        "scrollTo",
        typeof options === "object"
          ? (options.top ?? this.scrollTop)
          : this.scrollTop,
      )
    )
      return;
    if (typeof options === "object")
      this.scrollTop = options.top ?? this.scrollTop;
    this.dispatchEvent(new window.Event("scroll"));
  };
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = previous;
    if (callbackFailure) throw callbackFailure;
  };
}
const sourceSelector =
  '[data-quote-thread-id="runtime-thread"][data-quote-item-id="historical-5"]';
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

test("virtual composer, sent bubble and queued-editor source actions materialize exact old history without changing drafts", async () => {
  await withRuntimeDom(async (h) => {
    const restore = enableVirtualGeometry();
    let saves = 0;
    const composer = editComposer(
      emptyComposerState(),
      withSkillDraft("Unsent main question", [], [quote]),
    );
    try {
      await h.render(history(), {
        composer,
        onEditQueued: async (params) => {
          saves++;
          return {
            status: "edited",
            queuedItemId: params.queuedItemId,
            clientId: params.clientId,
            revision: params.expectedRevision + 1,
            editItemId: "unused",
          };
        },
      });
      await settle();
      assert.equal(
        document.querySelector(sourceSelector),
        null,
        "the old source starts unmounted",
      );
      const assertSource = async () => {
        const immediate = document.querySelector<HTMLElement>(sourceSelector);
        assert.ok(
          immediate,
          "the synchronous source callback returns an actual materialized target",
        );
        await settle();
        assert.equal(document.activeElement, immediate);
        assert.ok(
          document.querySelectorAll("[data-transcript-row-key]").length < 65,
        );
        assert.equal(saves, 0);
      };
      const backToLive = async () => {
        await act(async () =>
          (document.activeElement as HTMLElement | null)?.blur(),
        );
        await h.click(".back-live");
        await settle();
        assert.equal(
          document.querySelector(sourceSelector),
          null,
          "released source rows recycle normally",
        );
      };
      await h.click("#thread-composer .reference-token-details");
      await h.click(".reference-open-source");
      await assertSource();
      await backToLive();
      await h.click(
        '[data-sent-message-id="sent-quote"] .reference-token-details',
      );
      await h.click(".reference-open-source");
      await assertSource();
      await backToLive();
      await h.click('[data-queue-id="queue-0"] .queue-row-edit');
      assert.ok(document.querySelector(".queued-message-editor"));
      await h.click(".queued-message-editor .reference-token-details");
      await h.click(".reference-open-source");
      assert.equal(
        document.querySelector(".queued-message-editor"),
        null,
        "source navigation suspends the queue editor",
      );
      await assertSource();
      await h.click('[data-queue-id="queue-0"] .queue-row-edit');
      assert.match(
        document.querySelector(".queued-message-editor .cm-content")!
          .textContent!,
        /Queued question/,
      );
      assert.match(
        document.getElementById("thread-composer")!.textContent!,
        /Unsent main question/,
      );
      assert.equal(saves, 0);
      await h.click(".queued-message-editor .reference-token-details");
      const outside = document.createElement("button");
      document.body.append(outside);
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(".reference-open-source")!
          .click();
        outside.focus();
        outside.dispatchEvent(
          new window.MouseEvent("pointerdown", { button: 0, bubbles: true }),
        );
      });
      await settle();
      assert.equal(
        document.activeElement,
        outside,
        "a cancelled queued source request cannot steal the newer reader's focus",
      );
      assert.equal(saves, 0);
      outside.remove();
    } finally {
      restore();
    }
  });
});

for (const invalid of [
  { ...quote, id: "missing-source" },
  { ...quote, threadId: "another-thread" },
]) {
  test(`virtual queued source preserves the editor and explicit fallback for ${invalid.id}/${invalid.threadId}`, async () => {
    await withRuntimeDom(async (h) => {
      const restore = enableVirtualGeometry();
      let saves = 0;
      try {
        await h.render(history(invalid), {
          onEditQueued: async () => {
            saves++;
            throw new Error("unexpected save");
          },
        });
        await settle();
        await h.click('[data-queue-id="queue-0"] .queue-row-edit');
        await h.click(".queued-message-editor .reference-token-details");
        await h.click(".reference-open-source");
        await settle();
        assert.ok(document.querySelector(".queued-message-editor"));
        assert.ok(document.querySelector(".reference-source-error"));
        assert.match(
          document.querySelector(".queued-message-editor .cm-content")!
            .textContent!,
          /Queued question/,
        );
        assert.equal(saves, 0);
      } finally {
        restore();
      }
    });
  });
}

test("virtual tool-result source opens its exact nested trace disclosure and represented canonical alias", async () => {
  await withRuntimeDom(async (h) => {
    const restore = enableVirtualGeometry();
    const reference = {
      ...quote,
      id: "historical-result-5",
      excerpt: "Exact tool output 5",
    };
    const thread = history(reference);
    const turn = thread.turns.find((turn) => turn.id === "historical-turn-5")!;
    turn.items = [
      {
        ...runtimeCommand("historical-call-5"),
        aggregatedOutput: "Exact tool output 5",
      },
      runtimeCommand("historical-call-two-5"),
      ...turn.items,
    ];
    const stamp = {
      threadId: thread.id,
      turnId: turn.id,
      createdAt: "2026-11-03T00:00:00Z",
    };
    thread.canonicalItems!.push(
      {
        ...stamp,
        type: "tool_call",
        id: "historical-call-5",
        callId: "call-5",
        name: "shell",
        arguments: {},
      },
      {
        ...stamp,
        type: "tool_result",
        id: reference.id,
        callId: "call-5",
        output: reference.excerpt,
        exitCode: 0,
      },
      {
        ...stamp,
        type: "tool_call",
        id: "historical-call-two-5",
        callId: "call-two-5",
        name: "shell",
        arguments: {},
      },
    );
    try {
      await h.render(thread, {
        composer: editComposer(
          emptyComposerState(),
          withSkillDraft("Tool question", [], [reference]),
        ),
      });
      await settle();
      assert.equal(
        document.querySelector('[data-quote-item-id="historical-call-5"]'),
        null,
      );
      await h.click("#thread-composer .reference-token-details");
      await h.click(".reference-open-source");
      await settle();
      const target = document.querySelector<HTMLElement>(
        '[data-quote-item-id="historical-call-5"]',
      );
      assert.ok(target?.isConnected);
      assert.deepEqual(JSON.parse(target.dataset.quoteItemIds!), [
        "historical-call-5",
        reference.id,
      ]);
      assert.equal(target.closest("[aria-hidden='true'],[inert]"), null);
      assert.equal(document.activeElement, target);
      const row = target.closest("[data-transcript-row-key]")!;
      assert.equal(
        row.querySelector(".turn-toggle")!.getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        row.querySelector(".trace-toggle")!.getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        row.querySelector(".trace-item-toggle")!.getAttribute("aria-expanded"),
        "true",
      );
      assert.ok(
        document.querySelectorAll("[data-transcript-row-key]").length < 65,
      );
    } finally {
      restore();
    }
  });
});

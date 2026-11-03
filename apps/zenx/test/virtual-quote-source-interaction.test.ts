import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import { queueScenario } from "./fixtures/agent-queue-data.js";
import {
  runtimeMessage,
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
function history() {
  const thread = queueScenario(1);
  const turns = Array.from({ length: 1000 }, (_, index) => ({
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
  const payload = referenceMessage("Sent question", [quote], "sent-client");
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
                    [quote],
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
  Object.defineProperties(proto, {
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 600 : 280;
      },
    },
    clientWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 600 : 280;
      },
    },
    offsetWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 280840 : 280;
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
  });
  proto.scrollTo = function (options) {
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
        document.querySelector("#thread-composer .cm-content")!.textContent!,
        /Unsent main question/,
      );
      assert.equal(saves, 0);
    } finally {
      restore();
    }
  });
});

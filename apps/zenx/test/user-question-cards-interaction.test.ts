import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import "../src/renderer/src/i18n.js";
import { UserQuestionCards } from "../src/renderer/src/UserQuestionCards.js";
import { createUserQuestionStore } from "../src/renderer/src/user-question-state.js";
import type { UserQuestionState } from "../../../src/user-question-state.js";

function props(element: Element) {
  const key = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  assert.ok(key);
  return (element as unknown as Record<string, any>)[key]!;
}
for (const boundary of ["disabled", "thread", "room", "unmount"] as const) {
  test(`retained question Send/Cancel/Edit handlers cannot cross committed ${boundary} ownership`, async () => {
    const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
    };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const root = createRoot(document.getElementById("root")!);
    let writes = 0;
    const store = createUserQuestionStore({
      list: async ({ threadId }) => ({
        questions: [
          {
            request: { threadId, callItemId: "same-call" },
            resultItemId: "result",
            createdAt: "2026-11-02T00:00:00Z",
            state: "open",
            specification: {
              questions: [{ id: "q", prompt: "Synthetic question" }],
              answerTemplate: "{{q}}",
            },
          } satisfies UserQuestionState,
        ],
        totalPending: 1,
      }),
      read: async () => {
        throw new Error("Unexpected read");
      },
      respond: async () => {
        writes++;
        throw new Error("lost response");
      },
    });
    const render = (threadId = "original", disabled = false) =>
      act(async () =>
        root.render(
          React.createElement(UserQuestionCards, { threadId, disabled, store }),
        ),
      );
    try {
      await render();
      await act(async () =>
        store.edit("original", "same-call", [
          { questionId: "q", optionIds: [], text: "keep my draft" },
        ]),
      );
      const article = document.querySelector(".user-question-card")!;
      const send = props(article.querySelector(".primary-button")!).onClick;
      const cancel = props(
        article.querySelector(".user-question-actions button")!,
      ).onClick;
      const edit = props(article.querySelector("textarea")!).onChange;
      if (boundary === "disabled") await render("original", true);
      else if (boundary === "thread") await render("other");
      else
        await act(async () =>
          root.render(
            boundary === "room"
              ? React.createElement("div", null, "Room")
              : null,
          ),
        );
      await act(async () => {
        edit({ target: { value: "stale edit" } });
        send();
        cancel();
      });
      assert.equal(writes, 0);
      assert.equal(
        store.get("original").cards["same-call"]!.draft.answers[0]!.text,
        "keep my draft",
      );
      if (boundary === "thread")
        assert.equal(
          store.get("other").cards["same-call"]!.draft.answers[0]!.text,
          undefined,
        );
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    }
  });
}

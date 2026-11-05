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
import { questionNativeFixture } from "./user-question-native-fixture.js";

function props(element: Element) {
  const key = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  assert.ok(key);
  return (element as unknown as Record<string, any>)[key]!;
}

for (const outcome of ["answer", "cancel"] as const) {
  test(`template-free real native questions remain actionable after Turn completion for explicit UI ${outcome}`, async () => {
    const f = await questionNativeFixture();
    const dom = new JSDOM(
      "<button id='outside'>Keep focus</button><div id='root'></div>",
      { url: "http://localhost" },
    );
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
    const clientId = `template-free-ui-${outcome}`;
    const store = createUserQuestionStore(
      {
        ...f.transport,
        respond: (input) => {
          writes++;
          return f.transport.respond(input);
        },
      },
      () => clientId,
    );
    try {
      const thread = await f.host.startThread();
      const question = await f.publish(thread.id);
      assert.equal(question.specification.answerTemplate, "scope: {{scope}}");
      const summary = await f.host.readThreadSummary(thread.id);
      assert.equal(summary.status, "idle");
      document.getElementById("outside")!.focus();
      await act(async () => {
        root.render(
          React.createElement(UserQuestionCards, {
            threadId: thread.id,
            store,
          }),
        );
        await store.refresh(thread.id);
      });
      assert.equal(
        document.activeElement?.id,
        "outside",
        "late question rendering never steals focus",
      );
      const article = document.querySelector(".user-question-card")!;
      assert.match(article.textContent!, /Which scope should we use\?/);
      assert.match(article.textContent!, /Small/);
      assert.equal(article.querySelectorAll("input:checked").length, 0);
      assert.equal(writes, 0);
      await act(async () =>
        props(article.querySelector("textarea")!).onChange({
          target: { value: "Answer after completed work" },
        }),
      );
      const action =
        outcome === "answer"
          ? article.querySelector<HTMLButtonElement>(".primary-button")!
          : article.querySelector<HTMLButtonElement>(
              ".user-question-actions button",
            )!;
      assert.equal(action.disabled, false);
      const retained = props(action).onClick;
      await act(async () => {
        retained();
        for (let i = 0; i < 200; i++) {
          if (
            store.get(thread.id).cards[question.request.callItemId]?.attempt
              ?.phase === "claimed"
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });
      const result = await f.host.readUserQuestion(
        thread.id,
        question.request.callItemId,
        clientId,
      );
      assert.equal(result.response.status, "claimed");
      assert.equal(result.response.reply?.outcome, outcome);
      assert.equal(
        result.question?.state,
        outcome === "answer" ? "answered" : "cancelled",
      );
      assert.equal(writes, 1);
      await act(async () => retained());
      assert.equal(writes, 1, "retained completed UI actions cannot resubmit");
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
      await f.close();
    }
  });
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

test("question cards avoid repeated open headings and distinguish optional details from a free answer", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const question: UserQuestionState = {
    request: { threadId: "synthetic", callItemId: "question" },
    resultItemId: "result",
    createdAt: "2026-11-05T00:00:00Z",
    state: "open",
    specification: {
      questions: [
        {
          id: "choice",
          prompt: "Which format?",
          options: [{ id: "brief", label: "Brief" }],
        },
        { id: "free", prompt: "When should it arrive?" },
      ],
      answerTemplate: "{{choice}}\n{{free}}",
    },
  };
  const store = createUserQuestionStore({
    list: async () => ({ questions: [question], totalPending: 1 }),
    read: async () => {
      throw new Error("No synthetic readback");
    },
    respond: async () => {
      throw new Error("No synthetic submission");
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        React.createElement(UserQuestionCards, {
          threadId: "synthetic",
          store,
        }),
      );
      await store.refresh("synthetic");
    });
    assert.equal(
      document.querySelectorAll(".user-question-attention h3").length,
      1,
    );
    assert.equal(document.querySelectorAll(".user-question-status").length, 0);
    assert.equal(
      document.querySelectorAll(".user-question-text > span").length,
      1,
    );
    const fields = [...document.querySelectorAll("textarea")];
    assert.equal(fields.length, 2);
    assert.match(fields[0]!.getAttribute("aria-label")!, /^Which format\? · /);
    assert.equal(
      fields[1]!.getAttribute("aria-label"),
      "When should it arrive?",
    );
    await act(async () => {
      props(fields[0]!).onChange({ target: { value: "Custom format" } });
    });
    await act(async () => {
      props(fields[1]!).onChange({ target: { value: "Friday" } });
    });
    assert.deepEqual(store.get("synthetic").cards.question!.draft.answers, [
      { questionId: "choice", optionIds: [], text: "Custom format" },
      { questionId: "free", optionIds: [], text: "Friday" },
    ]);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".primary-button")!.disabled,
      false,
    );
    question.state = "unavailable";
    await act(async () => {
      await store.refresh("synthetic");
    });
    assert.equal(
      document.querySelectorAll('.user-question-status[role="status"]').length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

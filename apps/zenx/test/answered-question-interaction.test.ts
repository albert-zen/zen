import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { answeredQuestionFixture } from "./fixtures/answered-question-data.js";

test("question chips separate intrinsic width from responsive containment", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/answered-question.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.answered-question-trigger-wrap\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;/su,
  );
  assert.match(
    css,
    /\.answered-question-trigger\s*\{[^}]*min-width: 0;[^}]*max-width: 260px;/su,
  );
});

test("real ThreadView renders labels and text, reveals question on hover/click, dismisses and retires on navigation", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, {
    zenx: {
      triggers: { list: async () => [] },
      plugins: { executeCommand: async () => null },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const render = (missing = false, empty = false) =>
    root.render(
      React.createElement(ThreadView, {
        thread: empty
          ? {
              ...answeredQuestionFixture(),
              id: "other",
              turns: [],
              canonicalItems: [],
            }
          : answeredQuestionFixture(missing),
        composer: emptyComposerState(),
        approvals: [],
        onDraftChange: () => {},
        onInterrupt: async () => {},
        onRespondToApproval: async () => {},
        onSubmit: async () => {},
      }),
    );
  try {
    await act(async () => render());
    const answers = [
      ...document.querySelectorAll(".answered-question-answer"),
    ].map((element) => element.textContent!);
    assert.equal(answers.length, 2);
    assert.equal(answers[0], "一页摘要");
    assert.equal(
      answers[1],
      "请保留重点案例，周五前发给我。\n这里的 **标记** 是我的原文。",
    );
    assert.doesNotMatch(
      answers.join(""),
      /完整明细|暂不整理|重点、风险和下一步|Reply to|scope:|summary/,
    );
    assert.equal(
      document.querySelectorAll(".answered-question-trigger").length,
      2,
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      ".answered-question-trigger",
    )!;
    assert.equal(
      trigger.parentElement?.className,
      "answered-question-trigger-wrap",
    );
    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("pointerover", { bubbles: true }),
      );
    });
    assert.match(
      document.querySelector(".answered-question-popover")!.textContent!,
      /暂不整理/,
    );
    const choices = document.querySelectorAll(".answered-question-popover li");
    assert.equal(choices.length, 3);
    assert.equal(choices[0]?.getAttribute("data-selected"), "true");
    assert.equal(choices[1]?.getAttribute("data-selected"), "false");
    assert.equal(choices[2]?.getAttribute("data-selected"), "false");
    assert.ok(choices[0]?.querySelector('[role="img"][aria-label="Selected"]'));
    await act(async () => trigger.click());
    await act(async () => {
      trigger.dispatchEvent(
        new window.MouseEvent("pointerout", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    assert.ok(
      document.querySelector(".answered-question-popover"),
      "click pins hover disclosure",
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector(".answered-question-popover"), null);
    await act(async () => trigger.click());
    assert.ok(document.querySelector(".answered-question-popover"));
    await act(async () => render(false, true));
    assert.equal(document.querySelector(".answered-question-popover"), null);
    await act(async () => render(true));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".answered-question-trigger")!
        .click(),
    );
    assert.match(
      document.querySelector(".answered-question-popover")!.textContent!,
      /unavailable/,
    );
    assert.match(
      document.querySelector(".answered-question-answer")!.textContent!,
      /scope:/,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

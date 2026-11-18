import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { i18n } from "../src/renderer/src/i18n.js";
import { UserQuestionCards } from "../src/renderer/src/UserQuestionCards.js";
import { createUserQuestionStore } from "../src/renderer/src/user-question-state.js";
import type { UserQuestionState } from "../../../src/user-question-state.js";

for (const language of ["en", "zh-CN"] as const) {
  test(`choice hints describe actual single/multi/free contract in ${language}`, async () => {
    const dom = new JSDOM(
      '<button id="outside">Outside</button><div id="root"></div>',
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
    await i18n.changeLanguage(language);
    const options = [
      { id: "a", label: "First" },
      { id: "b", label: "Second" },
    ];
    const question: UserQuestionState = {
      request: { threadId: "hint-fixture", callItemId: "call" },
      resultItemId: "result",
      createdAt: "2026-11-18T00:00:00Z",
      state: "open",
      specification: {
        questions: [
          { id: "single", prompt: "Single prompt", options },
          {
            id: "multi",
            prompt: "Multiple prompt",
            options,
            multiSelect: true,
          },
          { id: "free", prompt: "Free prompt" },
        ],
        answerTemplate: "{{single}}\n{{multi}}\n{{free}}",
      },
    };
    const store = createUserQuestionStore({
      list: async () => ({ questions: [question], totalPending: 1 }),
      read: async () => {
        throw Error("unused");
      },
      respond: async () => {
        throw Error("must not submit");
      },
    });
    const root = createRoot(document.getElementById("root")!);
    try {
      document.getElementById("outside")!.focus();
      await act(async () => {
        root.render(
          React.createElement(UserQuestionCards, {
            threadId: "hint-fixture",
            store,
          }),
        );
        await store.refresh("hint-fixture");
      });
      const fields = [...document.querySelectorAll("fieldset")];
      const hints = [
        ...document.querySelectorAll(".user-question-choice-hint"),
      ];
      assert.equal(hints.length, 2);
      assert.equal(fields.length, 3);
      assert.deepEqual(
        hints.map((x) => x.textContent),
        language === "en"
          ? [
              "Choose one or write an answer.",
              "Choose options or write an answer.",
            ]
          : [
              "可选一项，也可以直接填写回答。",
              "可选多项，也可以直接填写回答。",
            ],
      );
      for (let i = 0; i < 2; i++) {
        assert.equal(fields[i]!.getAttribute("aria-describedby"), hints[i]!.id);
        assert.equal(
          document.querySelectorAll(`[id="${hints[i]!.id}"]`).length,
          1,
        );
        assert.equal(
          hints[i]!.nextElementSibling?.className,
          "user-question-options",
        );
        assert.equal(hints[i]!.getAttribute("role"), null);
        assert.equal(hints[i]!.getAttribute("aria-live"), null);
        assert.equal(
          fields[i]!.querySelectorAll("input[aria-describedby]").length,
          0,
          "Do not repeat group hint on every input",
        );
      }
      const assertAnswerLabels = () => {
        const label =
          language === "en"
            ? "Write an answer or add details"
            : "填写回答或补充说明";
        for (const field of fields.slice(0, 2)) {
          assert.equal(
            field.querySelector(".user-question-text > span")?.textContent,
            label,
          );
          assert.equal(
            field.querySelector("textarea")?.getAttribute("aria-label"),
            `${field.querySelector("legend")?.textContent} · ${label}`,
          );
        }
        assert.equal(
          fields[2]!.querySelector(".user-question-text > span"),
          null,
        );
        assert.equal(
          fields[2]!.querySelector("textarea")?.getAttribute("aria-label"),
          "Free prompt",
        );
      };
      assertAnswerLabels();
      assert.equal(fields[2]!.hasAttribute("aria-describedby"), false);
      assert.equal(fields[0]!.querySelectorAll("input[type=radio]").length, 2);
      assert.equal(
        fields[1]!.querySelectorAll("input[type=checkbox]").length,
        2,
      );
      assert.equal(document.activeElement?.id, "outside");
      const send = () =>
        document.querySelector<HTMLButtonElement>(".primary-button")!;
      assert.equal(send().disabled, true);
      // Text alone can answer a choice; each remaining question still needs an answer.
      await act(async () => {
        store.edit("hint-fixture", "call", [
          { questionId: "single", optionIds: [], text: "Custom answer" },
          { questionId: "multi", optionIds: [] },
          { questionId: "free", optionIds: [] },
        ]);
      });
      assert.equal(send().disabled, true);
      await act(async () => {
        store.edit("hint-fixture", "call", [
          { questionId: "single", optionIds: [], text: "Custom answer" },
          { questionId: "multi", optionIds: ["a", "b"] },
          { questionId: "free", optionIds: [], text: "Free answer" },
        ]);
      });
      assert.equal(send().disabled, false);
      assertAnswerLabels();
      assert.equal(
        document.querySelectorAll(".user-question-choice-hint").length,
        2,
      );
      assert.equal(document.activeElement?.id, "outside");
    } finally {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Room answer labels support unselected and selected options without changing free-text UI in ${language}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
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
    await i18n.changeLanguage(language);
    const options = [
      { id: "a", label: "First" },
      { id: "b", label: "Second" },
    ];
    Object.assign(window, {
      zenx: {
        roomQuestions: {
          onChanged: () => () => {},
          request: async ({ method }: { method: string }) => {
            assert.equal(
              method,
              "list",
              "this presentation test never submits",
            );
            return {
              roomId: "label-room",
              revision: 1,
              openCount: 1,
              totalQuestions: 1,
              questions: [
                {
                  roomId: "label-room",
                  id: "question",
                  revision: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  origin: { threadId: "author", callItemId: "call" },
                  state: "open",
                  specification: {
                    questions: [
                      { id: "single", prompt: "Single prompt", options },
                      {
                        id: "multi",
                        prompt: "Multiple prompt",
                        options,
                        multiSelect: true,
                      },
                      { id: "free", prompt: "Free prompt" },
                    ],
                    answerTemplate: "{{single}}\n{{multi}}\n{{free}}",
                  },
                },
              ],
            };
          },
        },
      },
    });
    const { RoomQuestionCards } =
      await import("../src/renderer/src/RoomQuestionCards.js");
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(
          React.createElement(RoomQuestionCards, {
            roomId: "label-room",
            members: [],
            threads: [],
          }),
        );
      });
      const fields = [...document.querySelectorAll("fieldset")];
      assert.equal(fields.length, 3);
      const verify = () => {
        const label =
          language === "en"
            ? "Write an answer or add details"
            : "填写回答或补充说明";
        for (const field of fields.slice(0, 2)) {
          assert.equal(
            field.querySelector(".user-question-text > span")?.textContent,
            label,
          );
          assert.equal(
            field.querySelector("textarea")?.getAttribute("aria-label"),
            `${field.querySelector("legend")?.textContent} · ${label}`,
          );
        }
        assert.equal(
          fields[2]!.querySelector(".user-question-text > span"),
          null,
        );
        assert.equal(
          fields[2]!.querySelector("textarea")?.getAttribute("aria-label"),
          "Free prompt",
        );
      };
      verify();
      for (const field of fields.slice(0, 2))
        await act(async () => {
          field.querySelector<HTMLInputElement>("input")!.click();
        });
      assert.equal(document.querySelectorAll("input:checked").length, 2);
      verify();
    } finally {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    }
  });
}

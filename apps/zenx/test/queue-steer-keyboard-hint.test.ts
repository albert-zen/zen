import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import {
  QueuedMessages,
  type QueuedMessagesProps,
} from "../src/renderer/src/QueuedMessages.js";
import { i18n } from "../src/renderer/src/i18n.js";

Object.assign(globalThis, { React });
const props: QueuedMessagesProps = {
  threadId: "synthetic-thread",
  integrated: true,
  running: true,
  onSteer: () => {
    throw Error("Rendering must never steer");
  },
  messages: [
    {
      id: "synthetic-item",
      clientId: "synthetic-client",
      text: "A synthetic long queued instruction for keyboard readability.",
      imageCount: 0,
      sender: {
        threadId: "synthetic-source",
        threadName: "Planning assistant",
        toolCallId: "synthetic-tool",
        callId: "synthetic-call",
      },
    },
  ],
};
for (const language of ["en", "zh-CN"]) {
  test(`${language}: rich agent queue exposes a visual-only existing Steer label without changing the action name`, async () => {
    const previous = i18n.language;
    await i18n.changeLanguage(language);
    const dom = new JSDOM(
      renderToStaticMarkup(React.createElement(QueuedMessages, props)),
    );
    try {
      const hint = dom.window.document.querySelector(
        ".queue-steer-keyboard-hint",
      )!;
      const button = dom.window.document.querySelector(".queue-row-steer")!;
      assert.equal(
        hint.textContent,
        language === "en" ? "Steer now" : "立即引导",
      );
      assert.equal(hint.getAttribute("aria-hidden"), "true");
      assert.equal(hint.getAttribute("role"), null);
      assert.equal(hint.getAttribute("tabindex"), null);
      assert.equal(button.textContent, "");
      assert.equal(
        button.getAttribute("aria-label"),
        i18n.t("shell:queueSteerMessage", { number: 1 }),
      );
      assert.equal(button.getAttribute("title"), i18n.t("shell:steerNow"));
      assert.equal(
        dom.window.document.querySelectorAll(".queue-row-steer").length,
        1,
      );
      assert(hint.closest(".queue-message-group.has-sender"));
    } finally {
      dom.window.close();
      await i18n.changeLanguage(previous);
    }
  });
}
test("the enhancement stays absent for other unobserved source and lifecycle states", () => {
  for (const overrides of [
    { running: false },
    { integrated: false },
    { onSteer: undefined },
    { steeringIds: new Set(["synthetic-item"]) },
    { messages: [{ ...props.messages[0]!, sender: undefined }] },
    {
      messages: [
        {
          ...props.messages[0]!,
          hostSource: {
            source: "trigger" as const,
            sourceId: "synthetic-trigger",
          },
        },
      ],
    },
  ]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        React.createElement(QueuedMessages, { ...props, ...overrides }),
      ),
    );
    try {
      assert.equal(
        dom.window.document.querySelector(".queue-steer-keyboard-hint"),
        null,
      );
    } finally {
      dom.window.close();
    }
  }
});
test("desktop hint requires keyboard focus, takes no layout space and cannot obscure its source line", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/queued-messages.css", import.meta.url),
    "utf8",
  );
  const section = css.slice(css.indexOf("/* The observed rich sender row"));
  assert.match(section, /@media \(min-width: 961px\)/);
  assert.match(section, /\.queue-steer-keyboard-hint\s*\{\s*display: none/);
  assert.match(section, /position: absolute/);
  assert.match(section, /visibility: hidden/);
  assert.match(section, /pointer-events: none/);
  assert.match(
    section,
    /:has\(\.queue-row-steer:focus-visible\)[\s\S]*visibility: visible/,
  );
  assert.match(section, /max-width: max\(0px, calc\(100% - 88px\)\)/);
  assert.doesNotMatch(section, /:hover|:focus-within/);
});

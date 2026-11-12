import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Icon, type IconName } from "../src/renderer/src/icons.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  MessageSourceLink,
  MessageSourceNavigationContext,
  MessageSourceViewportContext,
} from "../src/renderer/src/message-source-navigation.js";
Object.assign(globalThis, { React });

function icon(name: IconName, size = 16) {
  return new JSDOM(
    renderToStaticMarkup(React.createElement(Icon, { name, size })),
  );
}

test("Trigger and clock keys share the same inset artwork at every existing UI size", () => {
  for (const size of [12, 14, 16]) {
    const trigger = icon("trigger", size);
    const clock = icon("clock", size);
    try {
      const svg = trigger.window.document.querySelector("svg")!;
      assert.equal(
        svg.innerHTML,
        clock.window.document.querySelector("svg")!.innerHTML,
      );
      assert.equal(svg.getAttribute("width"), String(size));
      assert.equal(svg.getAttribute("height"), String(size));
      assert.equal(svg.getAttribute("viewBox"), "0 0 16 16");
      assert.equal(svg.getAttribute("aria-hidden"), "true");
      const face = svg.querySelector("circle")!;
      const stroke =
        Number(svg.querySelector("g")!.getAttribute("stroke-width")) / 2;
      const radius = Number(face.getAttribute("r")) + stroke;
      for (const coordinate of ["cx", "cy"]) {
        const center = Number(face.getAttribute(coordinate));
        assert.ok(
          center - radius > 0 && center + radius < 16,
          "clock stroke stays inside the shared viewBox",
        );
      }
    } finally {
      trigger.window.close();
      clock.window.close();
    }
  }
});

for (const language of ["en", "zh-CN"]) {
  test(`${language}: message sources use clock and conversation artwork without changing their names`, async () => {
    await i18n.changeLanguage(language);
    const label = language === "en" ? "Research worker" : "研究 Agent";
    const markup = renderToStaticMarkup(
      React.createElement(
        MessageSourceNavigationContext.Provider,
        { value: async () => {} },
        React.createElement(
          MessageSourceViewportContext.Provider,
          { value: "owner" },
          React.createElement(MessageSourceLink, {
            target: { kind: "thread", id: "worker" },
            label,
          }),
          React.createElement(MessageSourceLink, {
            target: { kind: "trigger", id: "timer" },
            label: i18n.t("shell:hostMessageTrigger"),
          }),
        ),
      ),
    );
    const dom = new JSDOM(markup);
    try {
      const buttons = [...dom.window.document.querySelectorAll("button")];
      assert.equal(
        buttons[0]!.querySelector("svg")!.getAttribute("data-icon"),
        "conversation",
      );
      assert.equal(buttons[0]!.textContent, label);
      assert.equal(buttons[0]!.getAttribute("title"), label);
      assert.equal(
        buttons[1]!.querySelector("svg")!.getAttribute("data-icon"),
        "trigger",
      );
      assert.ok(
        buttons[1]!.querySelector("circle"),
        "Trigger source uses the clock face",
      );
      assert.equal(buttons[1]!.textContent, i18n.t("shell:hostMessageTrigger"));
      assert.equal(buttons[1]!.getAttribute("title"), buttons[1]!.textContent);
      for (const button of buttons) {
        assert.equal(button.getAttribute("aria-disabled"), "false");
        assert.equal(button.querySelector("svg")!.getAttribute("width"), "12");
      }
    } finally {
      dom.window.close();
      await i18n.changeLanguage("en");
    }
  });
}

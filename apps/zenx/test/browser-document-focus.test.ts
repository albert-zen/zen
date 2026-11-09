import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { browserInspectScript } from "../src/main/capabilities/browser-provider.js";

test("inspection identifies document focus and follows focus moving away from a search field", () => {
  const dom = new JSDOM(
    '<style>* { opacity: 1 }</style><input id="search" type="search"><button id="message">Message</button>',
    { runScripts: "outside-only" },
  );
  try {
    const { window } = dom;
    window.CSS = { escape: (value: string) => value } as typeof window.CSS;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 100,
      height: 20,
      right: 100,
      bottom: 20,
      toJSON() {
        return {};
      },
    });
    const inspect = () =>
      (
        window.eval(browserInspectScript) as {
          targets: Array<{ id: string; documentFocused?: boolean }>;
        }
      ).targets;
    const search = window.document.querySelector<HTMLInputElement>("#search")!;
    const message =
      window.document.querySelector<HTMLButtonElement>("#message")!;
    assert.ok(inspect().every((target) => target.documentFocused === false));
    search.focus();
    const first = inspect();
    assert.equal(
      first.find((target) => target.id === "search")?.documentFocused,
      true,
    );
    assert.equal(
      first.find((target) => target.id === "message")?.documentFocused,
      false,
    );
    message.focus();
    const second = inspect();
    assert.equal(
      second.find((target) => target.id === "search")?.documentFocused,
      false,
    );
    assert.equal(
      second.find((target) => target.id === "message")?.documentFocused,
      true,
    );
    assert.equal(
      first.find((target) => target.id === "search")?.documentFocused,
      true,
      "past observation remains a snapshot, not live authority",
    );
  } finally {
    dom.window.close();
  }
});

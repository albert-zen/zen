import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Markdown,
  MessageLinkContext,
  type MarkdownInlineToken,
} from "../src/renderer/src/Markdown.js";
import { i18n } from "../src/renderer/src/i18n.js";

test("streaming skips unchanged Markdown work and retains context, locale and token updates", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // Count reads made inside the real Markdown body, not parent calls or timing.
  // Empty tokens exercise the ordinary text-only rendering path.
  const reads = Array<number>(100).fill(0);
  const tokens = reads.map(
    (_, index) =>
      new Proxy([] as MarkdownInlineToken[], {
        get(target, property, receiver) {
          if (property === "length") reads[index]! += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
  );
  let suffix = "";
  let tokenOverride: MarkdownInlineToken[] | undefined;
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  let onOpen = (target: { value: string }) => {
    firstCalls.push(target.value);
  };
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          MessageLinkContext.Provider,
          { value: onOpen },
          ...reads.map((_, index) =>
            createElement(Markdown, {
              key: index,
              text:
                index === 99
                  ? `**Live**${suffix}`
                  : `History ${index} [file](/tmp/example.txt)\n\n\`\`\`text\nplain\n\`\`\``,
              inlineTokens:
                index === 99 && tokenOverride ? tokenOverride : tokens[index],
            }),
          ),
        ),
      ),
    );
  try {
    await render();
    assert.ok(reads.every((count) => count > 0));
    const history = container.querySelector(".markdown-body");
    for (let delta = 0; delta < 3; delta += 1) {
      reads.fill(0);
      suffix += " delta";
      await render();
      assert.deepEqual(reads.slice(0, 99), Array(99).fill(0));
      assert.ok(reads[99]! > 0);
      assert.equal(container.querySelector(".markdown-body"), history);
      assert.equal(container.lastElementChild?.textContent, `Live${suffix}`);
    }
    reads.fill(0);
    await render();
    assert.deepEqual(reads, Array(100).fill(0));

    container.querySelector<HTMLAnchorElement>("a")!.click();
    assert.deepEqual(firstCalls, ["/tmp/example.txt"]);
    onOpen = (target) => {
      secondCalls.push(target.value);
    };
    reads.fill(0);
    await render();
    assert.ok(
      reads.every((count) => count > 0),
      "context changes invalidate memo",
    );
    container.querySelector<HTMLAnchorElement>("a")!.click();
    assert.deepEqual(firstCalls, ["/tmp/example.txt"]);
    assert.deepEqual(secondCalls, ["/tmp/example.txt"]);

    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.equal(
      container.querySelector(".markdown-code-actions button")?.textContent,
      i18n.t("panels:copy"),
    );
    assert.notEqual(
      container.querySelector(".markdown-code-actions button")?.textContent,
      "Copy",
    );
    // Theme is CSS-owned: a body that skips parsing still inherits the new theme.
    document.documentElement.dataset.theme = "dark";
    await render();
    assert.equal(container.querySelector(".markdown-body"), history);
    assert.equal(document.documentElement.dataset.theme, "dark");

    suffix = " TOKEN";
    tokenOverride = [
      {
        marker: "TOKEN",
        copyText: "reference one",
        node: createElement("span", null, "reference one"),
      },
    ];
    await render();
    assert.equal(container.lastElementChild?.textContent, "Live reference one");
    tokenOverride = [
      {
        marker: "TOKEN",
        copyText: "reference two",
        node: createElement("span", null, "reference two"),
      },
    ];
    await render();
    assert.equal(container.lastElementChild?.textContent, "Live reference two");
  } finally {
    await act(async () => {
      root.unmount();
      await i18n.changeLanguage("en");
    });
    container.remove();
    delete document.documentElement.dataset.theme;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: undefined });
  }
});

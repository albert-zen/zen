import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { RoomMessage } from "../src/main/trigger-types.js";
import { RoomMessageActions } from "../src/renderer/src/RoomMessageActions.js";
import { i18n } from "../src/renderer/src/i18n.js";

const message: RoomMessage = {
  id: "message-canonical /中",
  roomId: "room-canonical",
  author: "Recorded author",
  text: "A short message",
  kind: "agent",
  createdAt: 1,
  originThreadId: "thread-canonical /中",
  originTurnId: "turn-canonical",
};

async function harness(
  options: {
    message?: RoomMessage;
    disabled?: boolean;
    language?: "en" | "zh-CN";
  } = {},
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  await i18n.changeLanguage(options.language ?? "en");
  const root = createRoot(document.getElementById("root")!);
  const reactions: Array<string | null> = [];
  let replies = 0;
  const render = async (
    current = options.message ?? message,
    disabled = options.disabled ?? false,
  ) => {
    await act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "article",
            { className: "room-message", "data-kind": current.kind },
            React.createElement("header", null, current.author),
            React.createElement("p", null, current.text),
            React.createElement(RoomMessageActions, {
              message: current,
              disabled,
              operationId: "operation-canonical",
              onReply: () => {
                replies++;
                document
                  .querySelector<HTMLTextAreaElement>("textarea")!
                  .focus();
              },
              onReact: async (emoji) => {
                reactions.push(emoji);
              },
            }),
          ),
          React.createElement("textarea", { "aria-label": "Composer" }),
          React.createElement("button", { id: "outside" }, "Outside action"),
        ),
      ),
    );
  };
  await render();
  return {
    reactions,
    get replies() {
      return replies;
    },
    render,
    cleanup: async () => {
      await act(async () => root.unmount());
      await i18n.changeLanguage("en");
      dom.window.close();
    },
  };
}

function button(label: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) =>
      entry.getAttribute("aria-label") === label ||
      entry.textContent?.trim() === label,
  );
  assert.ok(target, `Missing button: ${label}`);
  return target;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

async function pointerClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(
      new window.MouseEvent("pointerdown", { bubbles: true }),
    );
    target.focus();
    target.click();
  });
}

async function key(target: HTMLElement, value: string) {
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: value, bubbles: true }),
    );
  });
}

async function settleFocus() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

test("idle message actions are icon-only and add no footer row, picker, or technical metadata", async () => {
  const view = await harness();
  try {
    const toolbar = document.querySelector<HTMLElement>(
      ".room-message-action-toolbar",
    )!;
    assert.equal(toolbar.getAttribute("role"), "group");
    assert.equal(toolbar.getAttribute("aria-label"), "Message actions");
    assert.equal(toolbar.textContent, "");
    assert.equal(toolbar.querySelectorAll("button").length, 3);
    assert.equal(toolbar.dataset.open, undefined);
    assert.equal(document.querySelector(".room-message-reactions"), null);
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(document.querySelector("details"), null);
    for (const id of [
      message.id,
      message.originThreadId!,
      message.originTurnId!,
      "operation-canonical",
    ])
      assert.ok(!document.body.textContent!.includes(id));
    for (const label of ["Reply", "React", "More actions"]) {
      const target = button(label);
      assert.equal(target.title, label);
      assert.equal(
        target.tabIndex,
        0,
        "hover-hidden controls stay keyboard reachable",
      );
      assert.equal(target.getAttribute("aria-hidden"), null);
    }
    await click(button("Reply"));
    assert.equal(view.replies, 1);
    assert.equal(document.activeElement, document.querySelector("textarea"));
  } finally {
    await view.cleanup();
  }
});

test("More exposes reply, reaction and technical details with keyboard navigation and Escape focus restoration", async () => {
  const view = await harness();
  try {
    const more = button("More actions");
    more.focus();
    await key(more, "ArrowDown");
    assert.equal(more.getAttribute("aria-expanded"), "true");
    assert.equal(
      document.querySelector<HTMLElement>(".room-message-action-toolbar")!
        .dataset.open,
      "true",
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    assert.deepEqual(
      [...menu.querySelectorAll('[role="menuitem"]')].map(
        (entry) => entry.textContent,
      ),
      ["Reply", "React", "Technical details"],
    );
    assert.equal(document.activeElement, button("Reply", menu));
    await key(document.activeElement as HTMLElement, "ArrowDown");
    assert.equal(document.activeElement, button("React", menu));
    await key(document.activeElement as HTMLElement, "End");
    assert.equal(document.activeElement, button("Technical details", menu));
    await key(document.activeElement as HTMLElement, "Home");
    assert.equal(document.activeElement, button("Reply", menu));
    await key(document.activeElement as HTMLElement, "Escape");
    await settleFocus();
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, more);
    assert.equal(more.getAttribute("aria-expanded"), "false");
  } finally {
    await view.cleanup();
  }
});

test("reply from More closes the menu without stealing focus back from the composer", async () => {
  const view = await harness();
  try {
    await click(button("More actions"));
    await click(button("Reply", document.querySelector('[role="menu"]')!));
    await settleFocus();
    assert.equal(view.replies, 1);
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(document.activeElement, document.querySelector("textarea"));
  } finally {
    await view.cleanup();
  }
});

test("the anchored six-emoji picker closes on selection, toggles own reaction off, and reopens cleanly", async () => {
  const current = {
    ...message,
    reactions: [{ actorId: "user", label: "You", emoji: "👍" }],
  };
  const view = await harness({ message: current });
  try {
    const react = button("React");
    await click(react);
    let picker = document.querySelector<HTMLElement>(
      ".room-message-reaction-picker",
    )!;
    assert.equal(
      picker.closest('[role="dialog"]')!.getAttribute("aria-label"),
      "Choose reaction",
    );
    assert.deepEqual(
      [...picker.querySelectorAll("button")].map((entry) => entry.textContent),
      ["👍", "❤️", "🎉", "👀", "✅", "🤔"],
    );
    assert.equal(
      button("Remove 👍 reaction", picker).getAttribute("aria-pressed"),
      "true",
    );
    await key(document.activeElement as HTMLElement, "ArrowRight");
    assert.equal(document.activeElement, button("React ❤️", picker));
    await click(button("React ❤️", picker));
    await settleFocus();
    assert.deepEqual(view.reactions, ["❤️"]);
    assert.equal(document.querySelector(".room-message-reaction-picker"), null);
    assert.equal(document.activeElement, react);
    await click(react);
    picker = document.querySelector<HTMLElement>(
      ".room-message-reaction-picker",
    )!;
    await click(button("Remove 👍 reaction", picker));
    assert.deepEqual(view.reactions, ["❤️", null]);
    await click(button("More actions"));
    await click(button("React", document.querySelector('[role="menu"]')!));
    assert.equal(
      button("More actions").getAttribute("aria-haspopup"),
      "dialog",
    );
    assert.equal(react.getAttribute("aria-expanded"), "false");
    assert.ok(
      document.querySelector(".room-message-reaction-picker"),
      "touch More reaches the same picker",
    );
    assert.equal(
      document.activeElement,
      button(
        "Remove 👍 reaction",
        document.querySelector(".room-message-reaction-picker")!,
      ),
    );
  } finally {
    await view.cleanup();
  }
});

test("reaction chips aggregate identical emojis and preserve attribution and exact user toggle callbacks", async () => {
  const current: RoomMessage = {
    ...message,
    reactions: [
      { actorId: "agent:a", label: "Research", emoji: "👍" },
      { actorId: "user", label: "You", emoji: "👍" },
      { actorId: "agent:b", label: "Writer", emoji: "🎉" },
    ],
  };
  const original = structuredClone(current);
  const view = await harness({ message: current });
  try {
    const chips = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".room-message-reaction-chip",
      ),
    ];
    assert.deepEqual(
      chips.map((chip) => chip.textContent),
      ["👍2", "🎉1"],
    );
    assert.equal(chips[0]!.getAttribute("aria-pressed"), "true");
    assert.equal(chips[1]!.getAttribute("aria-pressed"), "false");
    assert.equal(chips[0]!.title, "👍 · 2 · Research, You");
    assert.match(chips[0]!.getAttribute("aria-label")!, /Remove 👍 reaction/);
    assert.match(chips[1]!.getAttribute("aria-label")!, /Writer.*React 🎉/);
    await click(chips[0]!);
    await click(chips[1]!);
    assert.deepEqual(view.reactions, [null, "🎉"]);
    assert.deepEqual(
      current,
      original,
      "UI grouping does not mutate canonical data or attribution",
    );
  } finally {
    await view.cleanup();
  }
});

test("technical IDs appear only inside More → Technical details and Back restores action focus", async () => {
  const view = await harness();
  try {
    await click(button("More actions"));
    assert.ok(!document.body.textContent!.includes(message.id));
    await click(button("Technical details"));
    assert.equal(
      button("More actions").getAttribute("aria-haspopup"),
      "dialog",
    );
    const fields = document.querySelector(".room-message-technical-fields")!;
    assert.deepEqual(
      [...fields.querySelectorAll("dd")].map((entry) => entry.textContent),
      [
        message.id,
        message.originThreadId,
        message.originTurnId,
        "operation-canonical",
      ],
    );
    assert.equal(
      fields.closest('[role="dialog"]')!.getAttribute("aria-label"),
      "Technical details",
    );
    assert.equal(document.activeElement, button("Back · Message actions"));
    await click(button("Back · Message actions"));
    assert.equal(button("More actions").getAttribute("aria-haspopup"), "menu");
    assert.equal(
      document.querySelector(".room-message-technical-fields"),
      null,
    );
    assert.equal(
      document.activeElement,
      button("Reply", document.querySelector('[role="menu"]')!),
    );
    await click(button("Technical details"));
    await click(button("Close"));
    await settleFocus();
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(document.activeElement, button("More actions"));
  } finally {
    await view.cleanup();
  }
});

test("outside focus dismisses the popover without pulling focus back", async () => {
  const view = await harness();
  try {
    await click(button("More actions"));
    const outside = document.getElementById("outside")!;
    await act(async () => outside.focus());
    await settleFocus();
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(document.activeElement, outside);
  } finally {
    await view.cleanup();
  }
});

test("pointer clicks close More subviews, switch toolbar pickers, and dismiss outside without reopening", async () => {
  const view = await harness();
  try {
    const more = button("More actions");
    await pointerClick(more);
    await click(button("Technical details"));
    await pointerClick(more);
    await settleFocus();
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(more.getAttribute("aria-expanded"), "false");
    await pointerClick(more);
    await pointerClick(button("React"));
    assert.ok(document.querySelector(".room-message-reaction-picker"));
    assert.equal(button("React").getAttribute("aria-expanded"), "true");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    await pointerClick(button("React"));
    await settleFocus();
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    await pointerClick(more);
    const outside = document.getElementById("outside")!;
    await pointerClick(outside);
    await settleFocus();
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(document.activeElement?.id, "outside");
  } finally {
    await view.cleanup();
  }
});

test("Tab dismisses the action menu and releases focus to normal document navigation", async () => {
  const view = await harness();
  try {
    await click(button("More actions"));
    await key(document.activeElement as HTMLElement, "Tab");
    const outside = document.getElementById("outside")!;
    // JSDOM does not perform the browser's default Tab movement.
    await act(async () => outside.focus());
    await settleFocus();
    assert.equal(document.querySelector(".room-message-action-popover"), null);
    assert.equal(document.activeElement?.id, "outside");
  } finally {
    await view.cleanup();
  }
});

test("disabled sends block reply/reaction mutations while leaving technical details accessible", async () => {
  const view = await harness({
    disabled: true,
    message: {
      ...message,
      reactions: [{ actorId: "user", label: "You", emoji: "👍" }],
    },
  });
  try {
    assert.equal(button("Reply").disabled, true);
    assert.equal(button("React").disabled, true);
    const chip = document.querySelector<HTMLButtonElement>(
      ".room-message-reaction-chip",
    )!;
    assert.equal(chip.disabled, true);
    await click(button("Reply"));
    await click(chip);
    await click(button("More actions"));
    const menu = document.querySelector('[role="menu"]')!;
    assert.equal(button("Reply", menu).disabled, true);
    assert.equal(button("React", menu).disabled, true);
    assert.equal(document.activeElement, button("Technical details", menu));
    await click(button("Technical details", menu));
    assert.ok(document.querySelector(".room-message-technical-fields"));
    assert.equal(view.replies, 0);
    assert.deepEqual(view.reactions, []);
  } finally {
    await view.cleanup();
  }
});

test("message action labels and technical details respond to the selected language", async () => {
  const view = await harness({ language: "zh-CN" });
  try {
    await click(button("更多操作"));
    assert.ok(button("回复", document.querySelector('[role="menu"]')!));
    await click(button("技术详情"));
    assert.equal(
      document.querySelector('[role="dialog"]')!.getAttribute("aria-label"),
      "技术详情",
    );
    assert.equal(
      document.querySelector(".room-message-technical-fields dd")!.textContent,
      message.id,
    );
  } finally {
    await view.cleanup();
  }
});

test("toolbar styles reveal on message hover/focus or open menu, with a non-hover 44px More fallback", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/room-message-actions.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.room-message-action-toolbar\s*\{[^}]*position: absolute;[^}]*opacity: 0;[^}]*pointer-events: none;/s,
  );
  assert.match(
    css,
    /\.room-message:hover \.room-message-action-toolbar,\s*\.room-message:focus-within \.room-message-action-toolbar,\s*\.room-message-action-toolbar\[data-open="true"\]\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
  );
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)/);
  const touch = css.slice(css.indexOf("@media (hover: none)"));
  assert.match(
    touch,
    /\.room-message-action-toolbar\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
  );
  assert.match(
    touch,
    /\.room-message-action-toolbar > \.room-message-action-quick\s*\{\s*display: none;/,
  );
  assert.match(
    touch,
    /\.room-message-action-toolbar > \.room-message-action-more,[^{]+\{\s*min-width: 44px;\s*min-height: 44px;/s,
  );
  assert.ok(
    !css.includes("visibility: hidden"),
    "keyboard actions must remain focusable on desktop",
  );
});

for (const kind of ["human", "agent"] as const) {
  test(`${kind} message actions anchor away from its sender and timestamp`, async () => {
    const view = await harness({ message: { ...message, kind } });
    try {
      await click(button("More actions"));
      assert.equal(
        document.querySelector('[role="menu"]')!.getAttribute("data-align"),
        kind === "human" ? "start" : "end",
      );
      await click(button("Reply", document.querySelector('[role="menu"]')!));
      assert.equal(document.activeElement, document.querySelector("textarea"));
      assert.equal(view.replies, 1);
    } finally {
      await view.cleanup();
    }
  });
}

test("own header is right-aligned with left action space on mouse and touch; other headers retain right action space", async () => {
  const layout = await readFile(
    new URL("../src/renderer/src/rooms-layout.css", import.meta.url),
    "utf8",
  );
  const actions = await readFile(
    new URL("../src/renderer/src/room-message-actions.css", import.meta.url),
    "utf8",
  );
  assert.match(
    layout,
    /\.rooms-chat-feed \.room-message header\s*\{[^}]*padding-inline-end: 104px;/s,
  );
  assert.match(
    layout,
    /\.rooms-chat-feed \.room-message\[data-kind="human"\] header\s*\{[^}]*justify-content: flex-end;[^}]*padding-inline-start: 104px;[^}]*padding-inline-end: 0;/s,
  );
  assert.match(
    layout,
    /@media \(pointer: coarse\), \(hover: none\)\s*\{\s*\.rooms-chat-feed \.room-message\[data-kind="human"\] header\s*\{[^}]*padding-inline-start: 44px;[^}]*padding-inline-end: 0;/s,
  );
  assert.match(
    actions,
    /\.room-message\[data-kind="human"\] \.room-message-action-toolbar\s*\{[^}]*inset-inline-start: 0;[^}]*inset-inline-end: auto;/s,
  );
});

import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadView,
  ThreadViewActionsProvider,
} from "../src/renderer/src/ThreadView.js";
import { referenceMessage } from "../src/renderer/src/reference-draft.js";
import {
  emptyComposerState,
  editComposer,
  beginComposerSubmission,
  acceptComposerSubmission,
  failComposerSubmission,
} from "../src/renderer/src/composer-state.js";
import {
  parseSkillDraft,
  withSkillDraft,
} from "../src/renderer/src/skill-draft.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";
import {
  runtimeMessage,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";
import type { Thread } from "../src/protocol-client/index.js";
const { act, createElement } = React;
const quote = {
  kind: "message" as const,
  name: "ZenX",
  cwd: "/project",
  threadId: "thread-a",
  id: "source-a",
  excerpt: "Exact passage.",
};
const longQuote = {
  ...quote,
  excerpt: '  const code = "原文";\n\tsecond();\n\n  final();  ',
};
function base(): Thread {
  return {
    ...runtimeThread(
      [runtimeMessage("source-a", "Exact passage.\n\nMore context.")],
      "completed",
      "thread-a",
    ),
    canonicalItems: [
      {
        type: "agent_message",
        id: "source-a",
        threadId: "thread-a",
        turnId: "runtime-turn",
        createdAt: "2026-10-20T08:00:00Z",
        text: "Exact passage.\n\nMore context.",
      },
    ],
  };
}
function append(
  thread: Thread,
  payload: string,
  clientId?: string,
  extra: string[] = [],
): Thread {
  let next = applyNativeThreadEvent(thread, {
    type: "turn_started",
    threadId: thread.id,
    turnId: "sent-turn",
  });
  next = applyNativeThreadEvent(next, {
    type: "item_completed",
    item: {
      type: "user_message",
      id: "sent-item",
      threadId: thread.id,
      turnId: "sent-turn",
      createdAt: "2026-10-20T08:00:01Z",
      ...(clientId ? { clientId } : {}),
      content: [payload, ...extra].map((text) => ({
        type: "text" as const,
        text,
      })),
    },
  });
  return applyNativeThreadEvent(next, {
    type: "turn_completed",
    threadId: thread.id,
    turnId: "sent-turn",
    status: "completed",
  });
}
async function withView(
  initial: Thread,
  run: (api: {
    draft: () => ReturnType<typeof parseSkillDraft>;
    sends: string[];
    renderMissingSource(): Promise<void>;
  }) => Promise<void>,
  initialDraft = "Existing question",
  sourceNavigator?: import("../src/renderer/src/message-source-navigation.js").MessageSourceNavigator,
) {
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
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
    scrollIntoView() {},
  });
  Object.assign(dom.window.Range.prototype, {
    getClientRects: () => [
      { left: 50, top: 80, bottom: 100, right: 150, width: 100, height: 20 },
    ],
    getBoundingClientRect: () => ({
      left: 50,
      top: 80,
      bottom: 100,
      width: 100,
      height: 20,
    }),
  });
  let thread = initial;
  let composer = editComposer(emptyComposerState(), initialDraft);
  const sends: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const render = () => {
    const view = createElement(ThreadView, {
      thread,
      composer,
      approvals: [],
      onDraftChange: (text: string) => {
        composer = editComposer(composer, text);
        render();
      },
      onInterrupt: async () => {},
      onRespondToApproval: async () => {},
      onSubmit: async (intent, expected) => {
        composer = beginComposerSubmission(
          composer,
          intent,
          expected,
          () => "client-send",
        );
        const submission = composer.submission;
        assert.ok(submission);
        const draft = parseSkillDraft(submission.text);
        const payload = referenceMessage(
          draft.text,
          draft.references,
          submission.clientUserMessageId,
        );
        sends.push(payload);
        thread = append(thread, payload, submission.clientUserMessageId);
        composer = acceptComposerSubmission(
          composer,
          submission.clientUserMessageId,
        );
        render();
      },
    });
    root.render(
      sourceNavigator
        ? createElement(ThreadViewActionsProvider, {
            source: sourceNavigator,
            fork: async () => {},
            children: view,
          })
        : view,
    );
  };
  try {
    await act(async () => render());
    await run({
      draft: () => parseSkillDraft(composer.draft.text),
      sends,
      renderMissingSource: async () => {
        thread = {
          ...thread,
          canonicalItems: thread.canonicalItems?.filter(
            (item) => item.type !== "agent_message",
          ),
        };
        await act(async () => render());
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}
async function click(element: Element) {
  await act(async () =>
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  );
}
test("sent native user message renders two exact pills and ordinary question, without remove or a second editor", async () => {
  const payload = referenceMessage(
    "Please explain both.",
    [quote, longQuote],
    "client-a",
  );
  await withView(
    append(base(), payload, "client-a", ["Host skill snapshot stays visible."]),
    async ({ renderMissingSource }) => {
      const sent = document.querySelector(
        '[data-sent-message-id="sent-item"]',
      )!;
      assert.equal(sent.querySelectorAll(".reference-token").length, 2);
      assert.deepEqual(
        [...sent.querySelectorAll(".reference-token-details > span")].map(
          (node) => node.textContent,
        ),
        [quote.excerpt, longQuote.excerpt],
      );
      assert.equal(sent.querySelector(".reference-token-remove"), null);
      assert.ok(sent.querySelector(".user-bubble .reference-token"));
      assert.match(sent.textContent!, /Please explain both/);
      assert.match(sent.textContent!, /Host skill snapshot stays visible/);
      assert.ok(
        !sent
          .querySelector(".user-bubble")!
          .textContent!.includes("zenx-quoted-message"),
      );
      assert.equal(document.querySelectorAll("textarea").length, 1);
      await renderMissingSource();
      await click(sent.querySelector(".reference-token-details")!);
      await click(document.querySelector(".reference-open-source")!);
      assert.match(
        document.querySelector(".reference-details-popover")!.textContent!,
        /Source unavailable/,
      );
      assert.equal(
        sent.querySelector(".reference-token-details > span")!.textContent,
        quote.excerpt,
      );
    },
  );
});
test("unbound or malformed canonical text is never stripped into a quote presentation", async () => {
  const payload = referenceMessage("Question", [quote], "client-a");
  for (const [text, id] of [
    [payload, undefined],
    [payload, "different"],
    [payload.slice(0, -1), "client-a"],
    ["An ordinary [Message quote; excerpt: literal]", "client-a"],
  ] as const) {
    await withView(append(base(), text, id), async () => {
      const sent = document.querySelector(
        '[data-sent-message-id="sent-item"]',
      )!;
      assert.equal(sent.querySelectorAll(".reference-token").length, 0);
      assert.ok(sent.textContent!.includes(text.split("\n")[0]!));
    });
  }
});
test("select → quote → normal composer → explicit send appends real projected user message and clears only accepted draft", async () =>
  withView(base(), async ({ draft, sends }) => {
    const toggle = document.querySelector(".turn-toggle");
    if (toggle?.getAttribute("aria-expanded") === "false") await click(toggle);
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(
        document.querySelector('[data-quote-item-id="source-a"] p')!,
      );
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    const quoteButton = [
      ...document.querySelectorAll(".message-selection-actions button"),
    ].find((button) => button.textContent === "Quote")!;
    await click(quoteButton);
    assert.equal(draft().text.replaceAll("\uFFFC", ""), "Existing question");
    assert.equal(draft().references.length, 1);
    assert.equal(sends.length, 0);
    assert.ok(document.querySelector(".composer .reference-token"));
    assert.equal(
      document.querySelectorAll(".inline-composer-editor .reference-token")
        .length,
      1,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const composer = document.querySelector<HTMLElement>("#thread-composer")!;
    assert.ok(document.activeElement === composer);
    await act(async () =>
      composer.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      ),
    );
    assert.equal(sends.length, 0);
    await act(async () =>
      composer.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sends.length, 1);
    assert.equal(draft().references.length, 0);
    assert.equal(draft().text, "");
    const sent = document.querySelector('[data-sent-message-id="sent-item"]')!;
    assert.equal(
      sent.querySelector(".reference-token-details > span")!.textContent,
      quote.excerpt,
    );
    assert.match(sent.textContent!, /Existing question/);
  }));
test("retry preserves envelope identity; failure and newer edits keep their draft", () => {
  const draft = withSkillDraft("Question", [], [longQuote]);
  const pending = beginComposerSubmission(
    editComposer(emptyComposerState(), draft),
    "start",
    null,
    () => "client-retry",
  );
  const failed = failComposerSubmission(
    pending,
    "client-retry",
    "simulated error",
  );
  assert.equal(failed.draft.text, draft);
  const retried = beginComposerSubmission(
    failed,
    "start",
    null,
    () => "should-not-be-used",
  );
  assert.equal(retried.submission!.clientUserMessageId, "client-retry");
  const sent = referenceMessage(
    parseSkillDraft(retried.submission!.text).text,
    parseSkillDraft(retried.submission!.text).references,
    retried.submission!.clientUserMessageId,
  );
  assert.equal(referenceMessage("Question", [longQuote], "client-retry"), sent);
  const newer = editComposer(retried, "new question");
  assert.equal(
    acceptComposerSubmission(newer, "client-retry").draft.text,
    "new question",
  );
});

test("all five reference categories share inline tokens in draft and sent; removal changes only draft", async () => {
  const references = [
    {
      kind: "thread" as const,
      id: "thread-a",
      name: "引用体系设计",
      cwd: "/project",
    },
    { ...quote, name: "完整消息" },
    {
      kind: "thread" as const,
      id: "child-b",
      name: "检查发送边界",
      cwd: "/project",
    },
    { ...longQuote, name: "选段" },
    {
      kind: "file" as const,
      path: "reference-plan.md",
      name: "reference-plan.md",
      cwd: "/project",
    },
  ];
  const payload = referenceMessage("Question", references, "client-all");
  await withView(
    append(base(), payload, "client-all"),
    async ({ draft, sends }) => {
      const sent = document.querySelector(
        '[data-sent-message-id="sent-item"]',
      )!;
      const draftRail = document.querySelector(".inline-composer-editor")!;
      assert.deepEqual(
        [...draftRail.querySelectorAll(".reference-token")].map((el) =>
          el.getAttribute("data-reference-kind"),
        ),
        ["thread", "message", "thread", "message", "file"],
      );
      assert.deepEqual(
        [...sent.querySelectorAll(".reference-token")].map((el) =>
          el.getAttribute("data-reference-kind"),
        ),
        ["thread", "message", "thread", "message", "file"],
      );
      assert.ok(document.querySelector(".composer .reference-token"));
      assert.ok(sent.querySelector(".user-bubble .reference-token"));
      assert.equal(sent.querySelector(".reference-token-remove"), null);
      await click(
        draftRail.querySelector(
          '[data-reference-kind="file"] .reference-token-details',
        )!,
      );
      assert.match(
        document.querySelector(".reference-details-popover")!.textContent!,
        /Pointer only/,
      );
      assert.match(
        document.querySelector(".reference-details-popover")!.textContent!,
        /reference-plan.md/,
      );
      await click(
        document.querySelector('[aria-label="Close reference details"]')!,
      );
      await click(draftRail.querySelector(".reference-token-remove")!);
      assert.equal(draft().references.length, 4);
      assert.equal(sent.querySelectorAll(".reference-token").length, 5);
      assert.equal(sends.length, 0);
    },
    withSkillDraft("Question", [], references),
  );
});

test("normal Composer input events never promote pasted draft headers or strip literal prefixes", async () => {
  const header = withSkillDraft("literal suffix", [], [quote]);
  const literals = [
    header,
    `\\${header}`,
    `\\\\${header}`,
    "[zenx-references:%broken]\ntext",
    "[zenx-quoted-message:v1]\n{}",
    "[zenx-reference-message:v2]\n{}",
  ];
  await withView(
    base(),
    async ({ draft, sends }) => {
      for (const literal of literals) {
        const textarea =
          document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(textarea, literal);
          textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
          textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
        });
        assert.equal(textarea.value, literal);
        assert.equal(draft().text, literal);
        assert.deepEqual(draft().references, []);
        assert.equal(
          document.querySelectorAll(".inline-composer-editor .reference-token")
            .length,
          0,
        );
        await act(async () =>
          textarea.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
            }),
          ),
        );
        assert.equal(sends.at(-1), literal);
      }
    },
    "",
  );
});

test("legacy leading quote renders exact multiline reference instead of UUID JSON in the sent bubble", async () => {
  const payload = `[Message quote; thread ID: ${JSON.stringify(longQuote.threadId)}; message ID: ${JSON.stringify(longQuote.id)}; excerpt: ${JSON.stringify(longQuote.excerpt)}]Follow up`;
  await withView(append(base(), payload), async () => {
    const sent = document.querySelector('[data-sent-message-id="sent-item"]')!;
    assert.equal(sent.querySelectorAll(".reference-token").length, 1);
    assert.equal(
      sent.querySelector(".reference-token-details > span")!.textContent,
      longQuote.excerpt,
    );
    assert.match(sent.textContent!, /Follow up/);
    assert.ok(!sent.textContent!.includes("thread ID:"));
    assert.ok(!sent.textContent!.includes("\\n"));
    await click(sent.querySelector(".reference-token-details")!);
    assert.equal(
      document.querySelector(".reference-exact-excerpt")!.textContent,
      longQuote.excerpt,
    );
    await click(document.querySelector(".reference-open-source")!);
    assert.equal(
      (document.activeElement as HTMLElement).dataset.quoteItemId,
      "source-a",
    );
    assert.equal(
      (document.activeElement as HTMLElement).dataset.quoteThreadId,
      "thread-a",
    );
  });
});

test("structured clipboard paste into an ordinary composer preserves existing draft and sends the source capsule", async () => {
  const { referenceClipboard, REFERENCE_CLIPBOARD_TYPE } =
    await import("../src/renderer/src/reference-clipboard.js");
  const clipboard = referenceClipboard("\uFFFC", [
    { ...longQuote, position: 0 },
  ]);
  await withView(base(), async ({ draft, sends }) => {
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(8, 8);
    const paste = new window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === REFERENCE_CLIPBOARD_TYPE
            ? clipboard.structured
            : type === "text/plain"
              ? clipboard.plain
              : "",
        files: [],
      },
    });
    await act(async () => {
      textarea.dispatchEvent(paste);
    });
    assert.equal(paste.defaultPrevented, true);
    assert.equal(draft().text, "Existing\uFFFC question");
    assert.deepEqual(draft().references, [{ ...longQuote, position: 8 }]);
    const editor = document.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    )!;
    assert.ok(editor);
    assert.equal(document.activeElement, editor);
    assert.equal(sends.length, 0, "pasting never sends");
    await act(async () =>
      editor.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(sends.length, 1);
    const sent = document.querySelector('[data-sent-message-id="sent-item"]')!;
    assert.equal(
      sent.querySelector(".reference-token-details > span")!.textContent,
      longQuote.excerpt,
    );
    assert.ok(!sent.textContent!.includes("thread ID:"));
  });
});

test("cross-thread sent quote source action routes exact parent/child message through existing navigator", async () => {
  for (const sourceThreadId of ["synthetic-parent", "synthetic-child"]) {
    const reference = {
      ...longQuote,
      threadId: sourceThreadId,
      id: "exact-source-item",
      position: 0,
    };
    const payload = referenceMessage("\uFFFC", [reference], "cross-client");
    const requests: unknown[] = [];
    await withView(
      append(base(), payload, "cross-client"),
      async () => {
        const sent = document.querySelector(
          '[data-sent-message-id="sent-item"]',
        )!;
        await click(sent.querySelector(".reference-token-details")!);
        await click(document.querySelector(".reference-open-source")!);
        assert.deepEqual(requests, [
          {
            target: {
              kind: "thread",
              id: sourceThreadId,
              itemId: "exact-source-item",
            },
            ownerThreadId: "thread-a",
            current: true,
          },
        ]);
      },
      "Existing question",
      async (target, owner) => {
        requests.push({
          target,
          ownerThreadId: owner.threadId,
          current: owner.isCurrent(),
        });
      },
    );
  }
});

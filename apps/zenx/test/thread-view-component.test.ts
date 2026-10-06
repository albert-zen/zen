import "./dom-primitives.js";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { Thread, ThreadItem, Turn } from "../src/protocol-client/index.js";
import type { AttachmentRef } from "../../../src/attachment.js";
import type { CanonicalItem } from "../../../src/item.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";
import type { ModelUsageProjection } from "../../../src/model-usage.js";
import { projectCompletedItem } from "../../../src/protocol/codex/mapper.js";
import type { ApprovalCardState } from "../src/renderer/src/approval-state.js";
import {
  addComposerImages,
  editComposer,
  emptyComposerState,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const { ThreadView, ContextUsageIndicator } =
  await import("../src/renderer/src/ThreadView.js");
const { requestContextCompaction } =
  await import("../src/renderer/src/compact-command.js");

const noop = async () => undefined;

test("manual Skills are slash candidates and selection stays removable without sending", async () => {
  await withDom(async (root) => {
    let composer = editComposer(emptyComposerState(), "/sample");
    let sends = 0;
    const priorFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback(0);
      return 0;
    };
    const skill = {
      id: "11111111-1111-1111-1111-111111111111",
      name: "sample",
      description: "Manual instructions",
      source: "C:/original/sample",
      directory: "C:/host/sample",
      mode: "manual" as const,
      configurationSource: "default" as const,
    };
    Object.assign(window, {
      zenx: {
        skills: {
          list: async () => ({
            skills: [
              skill,
              {
                ...skill,
                id: "22222222-2222-2222-2222-222222222222",
                name: "disabled",
                mode: "disabled",
              },
            ],
            errors: [],
            catalogBudgetBytes: 16384,
          }),
        },
      },
    });
    const renderView = () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: null,
          onDraftChange: (text: string) => {
            composer = editComposer(composer, text);
            renderView();
          },
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: async () => {
            sends++;
          },
        }),
      );
    try {
      await act(async () => renderView());
      assert.match(
        requiredElement('[role="listbox"]').textContent ?? "",
        /sample/,
      );
      assert.doesNotMatch(
        requiredElement('[role="listbox"]').textContent ?? "",
        /disabled/,
      );
      await act(async () => requiredButton('[role="option"]').click());
      assert.equal(sends, 0);
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("textarea")!.value,
        "",
      );
      assert.match(composer.draft.text, /11111111/);
      await act(async () =>
        requiredButton('[aria-label="Remove Skill sample"]').click(),
      );
      assert.equal(composer.draft.text, "");
      assert.equal(sends, 0);
    } finally {
      globalThis.requestAnimationFrame = priorFrame;
    }
  });
});

test("idle composer exposes one disabled Send action when empty", () => {
  const html = render(false, []);
  assert.match(html, /aria-label="Send"/u);
  assert.match(html, /action-orb send/u);
  assert.doesNotMatch(html, /Steer now/u);
});

test("confirmed sends do not leave protocol receipts in the composer", () => {
  for (const stage of ["queued", "delivered", "completed", "ended"] as const) {
    const html = render(false, [], {
      ...emptyComposerState(),
      confirmedAdmission: { clientId: "sent-message", stage },
    });
    const form = html.match(/<form[\s\S]*?<\/form>/u)?.[0] ?? "";
    assert.ok(form);
    assert.doesNotMatch(
      form,
      /composer-note|containing this message|admitted to the queue|added to a Turn/u,
    );
  }
});

test("composer textarea opts into bounded content-driven growth", () => {
  const html = render(false, [], editComposer(emptyComposerState(), "draft"));
  assert.match(html, /<textarea[^>]*data-autogrow="true"/u);
});

test("context usage renders beside the composer with concise usage and cache details", () => {
  const html = renderTurns(
    [],
    [],
    emptyComposerState(),
    {},
    {
      thread: {
        responseCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        cacheHitRate: 0.5,
      },
      turns: {},
      context: {
        inputTokens: 78_200,
        inputTokenSource: "estimated",
        contextWindow: 262_000,
        ratio: 0.3,
      },
    },
  );
  assert.match(
    html,
    /class="composer-model-menu"|class="context-usage-indicator"/u,
  );
  assert.match(
    html,
    /class="context-usage-trigger"[^>]*aria-label="Open context details\. Context 30% · 78\.2K \/ 262K tokens[^"]*Thread cache 50%/u,
  );
  assert.match(html, /aria-haspopup="dialog"/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /stroke-dasharray="0\.3 1"/u);
});

test("context ring opens an accessible popover before its compact action runs", async () => {
  await withDom(async (root) => {
    let compactCalls = 0;
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: emptyComposerState(),
          thread: thread([turnWithItems("completed", [])]),
          threadUsage: usageProjection(),
          onCompact: async () => {
            compactCalls += 1;
          },
          onDraftChange: () => undefined,
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      ),
    );

    const ring = requiredButton(".context-usage-trigger");
    assert.equal(ring.getAttribute("aria-expanded"), "false");
    await act(async () => ring.focus());
    assert.equal(document.activeElement, ring);
    await act(async () => ring.click());
    assert.equal(compactCalls, 0);
    assert.equal(ring.getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.match(document.body.textContent ?? "", /78\.2K \/ 262K tokens/u);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Configured window|last provider|configured window tokens|estimated next input|Condense earlier|Your conversation/u,
    );
    assert.match(
      requiredElement('[role="progressbar"]').getAttribute("aria-valuetext") ??
        "",
      /Context 30% · 78\.2K \/ 262K tokens/u,
    );

    await act(async () => requiredButton(".context-usage-compact").click());
    assert.equal(compactCalls, 1);
  });
});

test("context pressure above the configured window keeps the real percent in its label", () => {
  const html = renderToStaticMarkup(
    createElement(ContextUsageIndicator, {
      context: {
        inputTokens: 587_500,
        inputTokenSource: "provider",
        contextWindow: 271_992,
        ratio: 587_500 / 271_992,
      },
      threadCacheHitRate: 0.96,
    }),
  );
  assert.match(html, /Context 216%/u);
  assert.match(html, /Thread cache 96%/u);
  assert.match(html, /587\.5K \/ 272K tokens/u);
  assert.doesNotMatch(html, /last provider|configured window/u);
  assert.match(html, /stroke-dasharray="1 1"/u);
});

test("context hover remains open across a real gap corridor above and below the ring, then closes outside or on Escape", async () => {
  for (const placement of ["above", "below"] as const) {
    await withDom(async (root) => {
      const anchorTop = placement === "above" ? 300 : 4;
      const anchorBottom = anchorTop + 28;
      const getRect = window.HTMLElement.prototype.getBoundingClientRect;
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.classList.contains("context-usage-indicator"))
          return new window.DOMRect(680, anchorTop, 28, 28);
        if (this.classList.contains("context-usage-popover"))
          return new window.DOMRect(422, 0, 286, 150);
        return getRect.call(this);
      };
      await act(async () =>
        root.render(
          createElement(ContextUsageIndicator, {
            context: usageProjection().context,
            threadCacheHitRate: 0.5,
            onCompact: noop,
          }),
        ),
      );
      const ring = requiredButton(".context-usage-trigger");
      await act(async () =>
        ring.dispatchEvent(
          new window.MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        ),
      );
      const panel = requiredElement<HTMLElement>(".context-usage-popover");
      const corridor = requiredElement<HTMLElement>(
        ".context-usage-hover-bridge",
      );
      assert.equal(panel.getAttribute("data-placement"), placement);
      assert.equal(corridor.style.position, "fixed");
      assert.equal(corridor.style.left, panel.style.left);
      assert.equal(corridor.style.width, panel.style.width);
      assert.equal(corridor.style.height, "8px");
      assert.equal(
        corridor.style.top,
        `${placement === "above" ? anchorTop - 8 : anchorBottom}px`,
      );
      assert.equal(corridor.getAttribute("aria-hidden"), "true");
      for (const [from, to] of [
        [ring, corridor],
        [corridor, panel],
        [panel, requiredButton(".context-usage-compact")],
      ] as const) {
        await act(async () =>
          from.dispatchEvent(
            new window.MouseEvent("mouseout", {
              bubbles: true,
              relatedTarget: to,
            }),
          ),
        );
        assert.ok(document.querySelector('[role="dialog"]'));
      }
      await act(async () =>
        panel.dispatchEvent(
          new window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        ),
      );
      assert.equal(document.querySelector('[role="dialog"]'), null);
      await act(async () => ring.focus());
      assert.ok(document.querySelector('[role="dialog"]'));
      await act(async () =>
        ring.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            bubbles: true,
            key: "Escape",
          }),
        ),
      );
      assert.equal(document.querySelector('[role="dialog"]'), null);
    });
  }
});

test("compaction progress is a transcript item and completed items reveal exact effective messages", async () => {
  const canonicalItems = compactionHistory();
  const completedThread: Thread = {
    ...thread([
      turnWithItems("completed", [
        user("Keep this request"),
        agent("Kept answer"),
      ]),
    ]),
    canonicalItems,
  };
  await withDom(async (root) => {
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: emptyComposerState(),
          thread: completedThread,
          onDraftChange: () => undefined,
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      ),
    );

    const event = requiredElement(".context-compaction-event");
    assert.match(event.textContent ?? "", /Context compacted/u);
    assert.match(event.textContent ?? "", /Human initiated/u);
    assert.match(event.textContent ?? "", /Full input size unknown/u);
    assert.doesNotMatch(event.textContent ?? "", /effective messages/u);
    await act(async () => requiredButton(".context-compaction-toggle").click());
    assert.match(event.textContent ?? "", /Keep this request/u);
    assert.match(event.textContent ?? "", /Kept answer/u);
    assert.match(event.textContent ?? "", /Continue with the accepted plan/u);
    assert.match(
      requiredElement(".compaction-summary").textContent ?? "",
      /Continue with the accepted plan/u,
    );
    assert.equal(
      requiredElement(".compaction-projection").hasAttribute("open"),
      false,
    );
    assert.match(event.textContent ?? "", /not tokens/u);
    assert.match(
      event.textContent ?? "",
      /request inputs may be added separately/u,
    );

    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: {
            ...emptyComposerState(),
            compaction: { status: "pending", message: "Compacting context…" },
          },
          thread: completedThread,
          onDraftChange: () => undefined,
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      ),
    );
    assert.match(
      requiredElement(".context-compaction-progress").textContent ?? "",
      /Compacting context/u,
    );
    assert.equal(document.querySelector(".composer-command-status"), null);
  });
});

test("compaction error is a keyboard-reachable context notice with plain details and explicit dismiss", async () => {
  await withDom(async (root) => {
    let composer: ComposerState = {
      ...emptyComposerState(),
      compaction: {
        status: "failed",
        message: "Could not confirm this compaction request.",
        detail: "Error invoking <script> & token hidden",
      },
    };
    let selected = thread([]);
    const renderView = () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: selected,
          onDraftChange: () => undefined,
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
          onDismissCompaction: () => {
            composer = { ...composer, compaction: undefined };
            renderView();
          },
        }),
      );
    await act(async () => renderView());
    const alert = requiredElement('[role="alert"].context-compaction-progress');
    assert.equal(alert.closest(".messages-inner"), null);
    assert.equal(alert.closest(".composer-error"), null);
    const details = requiredElement<HTMLDetailsElement>(
      ".context-compaction-error-detail",
    );
    assert.equal(details.open, false);
    const summary = requiredElement<HTMLElement>(
      ".context-compaction-error-detail summary",
    );
    assert.equal(summary.tabIndex, 0);
    assert.equal(document.querySelector("script"), null);
    assert.match(details.textContent ?? "", /<script>/u);
    await act(async () =>
      requiredButton('[aria-label="Dismiss compaction error"]').click(),
    );
    assert.equal(
      document.querySelector(".context-compaction-progress.is-error"),
      null,
    );
    selected = { ...selected, id: "other-thread" };
    await act(async () => renderView());
    assert.equal(
      document.querySelector(".context-compaction-progress.is-error"),
      null,
    );
  });
});

test("real compaction request rejection stays with its Thread, ignores stale completion and coexists with a canonical success", async () => {
  await withDom(async (root) => {
    const states: Record<string, ComposerState> = {
      a: emptyComposerState(),
      b: emptyComposerState(),
    };
    const a = { ...thread([]), id: "a", canonicalItems: compactionHistory() };
    const b = { ...thread([]), id: "b" };
    let selected: Thread = a;
    const renderView = () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: states[selected.id]!,
          thread: selected,
          onDraftChange: () => undefined,
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      );
    let reject!: (reason: unknown) => void;
    const pending = requestContextCompaction({
      threadId: "a",
      active: false,
      clearCommandDraft: false,
      read: () => states.a!,
      update: (change) => {
        states.a = change(states.a!);
        renderView();
      },
      compact: () =>
        new Promise((_, rejectRequest) => {
          reject = rejectRequest;
        }),
    });
    await act(async () => renderView());
    selected = b;
    await act(async () => renderView());
    reject(new Error("Error invoking remote method: private=secret"));
    await act(async () => pending);
    assert.equal(
      document.querySelector(".context-compaction-progress.is-error"),
      null,
    );
    selected = a;
    await act(async () => renderView());
    assert.match(
      requiredElement(".context-compaction-event").textContent ?? "",
      /Context compacted/u,
    );
    assert.match(
      requiredElement(".context-compaction-progress.is-error").textContent ??
        "",
      /Could not confirm/u,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /private=secret/u);
  });
});

test("context tooltip exposes exact zero and unknown Thread cache rates", () => {
  const zero = renderTurns(
    [],
    [],
    emptyComposerState(),
    {},
    {
      thread: {
        responseCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        cacheHitRate: 0,
      },
      turns: {},
      context: {
        inputTokens: 78_200,
        inputTokenSource: "estimated",
        contextWindow: 262_000,
        ratio: 0.3,
      },
    },
  );
  assert.match(
    zero,
    /Context 30% · 78\.2K \/ 262K tokens[^"]*Thread cache 0%/u,
  );

  const unknown = renderTurns(
    [],
    [],
    emptyComposerState(),
    {},
    {
      thread: { responseCount: 1, inputTokens: 10, outputTokens: 2 },
      turns: {},
      context: {
        inputTokens: 78_200,
        inputTokenSource: "estimated",
        contextWindow: 262_000,
        ratio: 0.3,
      },
    },
  );
  assert.match(
    unknown,
    /Context 30% · 78\.2K \/ 262K tokens[^"]*Thread cache unknown/u,
  );
});

test("context indicator hides unknown ratio instead of presenting zero", () => {
  const unknown = renderTurns(
    [],
    [],
    emptyComposerState(),
    {},
    {
      thread: { responseCount: 1, inputTokens: 10, outputTokens: 2 },
      turns: {},
      context: {
        inputTokens: null,
        inputTokenSource: null,
        contextWindow: null,
        ratio: null,
      },
    },
  );
  assert.doesNotMatch(unknown, /context-usage-indicator/u);
  const over = renderTurns(
    [],
    [],
    emptyComposerState(),
    {},
    {
      thread: { responseCount: 1, inputTokens: 10, outputTokens: 2 },
      turns: {},
      context: {
        inputTokens: 120,
        inputTokenSource: "provider",
        contextWindow: 100,
        ratio: 1.2,
      },
    },
  );
  assert.match(over, /aria-label="Open context details\. Context 120%/u);
  assert.match(over, /stroke-dasharray="1 1"/u);
});

test("composer textarea grows to its cap, scrolls, and shrinks after deletion", async () => {
  await withDom(async (root) => {
    let contentHeight = 240;
    Object.defineProperty(domTextAreaPrototype(), "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    const props = (text: string) =>
      createElement(ThreadView, {
        approvals: [],
        composer: editComposer(emptyComposerState(), text),
        thread: thread([]),
        onDraftChange: () => undefined,
        onInterrupt: noop,
        onRespondToApproval: noop,
        onSubmit: noop,
      });

    await act(async () => root.render(props("long draft")));
    const textarea = requiredElement<HTMLTextAreaElement>("#thread-composer");
    assert.equal(textarea.style.height, "136px");
    assert.equal(textarea.style.overflowY, "auto");

    contentHeight = 24;
    await act(async () => root.render(props("")));
    assert.equal(textarea.style.height, "36px");
    assert.equal(textarea.style.overflowY, "hidden");
  });
});

test("composer respects the viewport cap and remeasures on resize", async () => {
  await withDom(async (root) => {
    let contentHeight = 240;
    Object.defineProperty(domTextAreaPrototype(), "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 200,
    });
    const computedStyle = window.getComputedStyle;
    window.getComputedStyle = (() =>
      ({
        minHeight: "54px",
        maxHeight: `${Math.max(54, Math.min(136, window.innerHeight * 0.35 - 14))}px`,
      }) as unknown as CSSStyleDeclaration) as typeof window.getComputedStyle;
    try {
      const props = createElement(ThreadView, {
        approvals: [],
        composer: editComposer(emptyComposerState(), "long draft"),
        thread: thread([]),
        onDraftChange: () => undefined,
        onInterrupt: noop,
        onRespondToApproval: noop,
        onSubmit: noop,
      });
      await act(async () => root.render(props));
      const textarea = requiredElement<HTMLTextAreaElement>("#thread-composer");
      assert.equal(textarea.style.height, "56px");
      assert.equal(textarea.style.overflowY, "auto");

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 168,
      });
      await act(async () => window.dispatchEvent(new window.Event("resize")));
      assert.equal(textarea.style.height, "54px");
      assert.equal(textarea.style.overflowY, "auto");

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 600,
      });
      await act(async () => window.dispatchEvent(new window.Event("resize")));
      assert.equal(textarea.style.height, "136px");
      assert.equal(textarea.style.overflowY, "auto");
    } finally {
      window.getComputedStyle = computedStyle;
    }
  });
});

test("running empty composer exposes Stop without locking the editor", () => {
  const html = render(true, []);
  assert.match(html, /aria-label="Message"/u);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/u);
  assert.match(html, /aria-label="Stop"/u);
});

test("running draft keeps one send action and hides alternate choices until hover", () => {
  const composer = editComposer(emptyComposerState(), "change direction");
  const html = render(true, [], composer);
  assert.match(html, /aria-label="Steer now"/u);
  assert.doesNotMatch(html, />Next turn</u);
  assert.doesNotMatch(html, />Each turn</u);
  assert.doesNotMatch(html, /Interrupt without sending the draft/u);
});

test("mounted Thread queue disappears on canonical acceptance without navigation", async () => {
  await withDom(async (root) => {
    let current: Thread = {
      ...thread([turn()]),
      canonicalItems: [],
      queuedMessages: [],
    };
    const queued = {
      id: "queue-one",
      type: "user_message_queued" as const,
      threadId: current.id,
      clientId: "client-one",
      createdAt: new Date().toISOString(),
      input: [{ type: "text" as const, text: "identical" }],
    };
    current = applyNativeThreadEvent(current, {
      type: "item_completed",
      item: queued,
    });
    const show = async () =>
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: emptyComposerState(),
            thread: current,
            onDraftChange: () => undefined,
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
    await show();
    assert.match(
      document.querySelector('[aria-label="Message queue"]')?.textContent ?? "",
      /1 queued.*identical/u,
    );
    const queue = document.querySelector<HTMLElement>(
      '[aria-label="Message queue"]',
    );
    assert.equal(queue?.getAttribute("aria-live"), null);
    assert.equal(
      queue?.querySelector('[role="status"]')?.textContent,
      "1 queued",
    );
    current = applyNativeThreadEvent(current, {
      type: "item_completed",
      item: {
        id: "accepted-one",
        type: "user_message",
        threadId: current.id,
        turnId: "turn-1",
        clientId: "client-one",
        createdAt: new Date().toISOString(),
        content: queued.input,
      },
    });
    await show();
    assert.equal(document.querySelector('[aria-label="Message queue"]'), null);
    assert.equal(document.querySelectorAll(".user-row").length, 1);
  });
});

test("mounted queue cancel waits for canonical event instead of optimistically hiding a row", async () => {
  await withDom(async (root) => {
    let current: Thread = {
      ...thread([turn()]),
      canonicalItems: [],
      queuedMessages: [],
    };
    const queued = ["first", "second"].map((clientId) => ({
      id: `queued-${clientId}`,
      type: "user_message_queued" as const,
      threadId: current.id,
      clientId,
      createdAt: new Date().toISOString(),
      input: [{ type: "text" as const, text: "identical" }],
    }));
    for (const item of queued)
      current = applyNativeThreadEvent(current, {
        type: "item_completed",
        item,
      });
    let resolve!: (value: {
      results: [
        { queuedItemId: string; clientId: string; status: "cancelled" },
      ];
    }) => void;
    const pending = new Promise<{
      results: [
        { queuedItemId: string; clientId: string; status: "cancelled" },
      ];
    }>((done) => {
      resolve = done;
    });
    const requests: Array<{ queuedItemId: string; clientId: string }[]> = [];
    const show = async () =>
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: emptyComposerState(),
            thread: current,
            onCancelQueued: async (targets) => {
              requests.push([...targets]);
              return await pending;
            },
            onDraftChange: () => undefined,
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
    await show();
    await act(async () =>
      requiredButton('[aria-label="Cancel queued message 1"]').click(),
    );
    assert.deepEqual(requests, [
      [{ queuedItemId: queued[0]!.id, clientId: "first" }],
    ]);
    assert.match(
      document.querySelector(".queued-messages")?.textContent ?? "",
      /2 queued/u,
    );
    await act(async () =>
      resolve({
        results: [
          {
            queuedItemId: queued[0]!.id,
            clientId: "first",
            status: "cancelled",
          },
        ],
      }),
    );
    assert.match(
      document.querySelector(".queued-messages")?.textContent ?? "",
      /2 queued/u,
    );
    current = applyNativeThreadEvent(current, {
      type: "item_completed",
      item: {
        id: "cancel-first",
        type: "user_message_queue_cancelled",
        threadId: current.id,
        queuedItemId: queued[0]!.id,
        clientId: "first",
        createdAt: new Date().toISOString(),
      },
    });
    await show();
    assert.match(
      document.querySelector(".queued-messages")?.textContent ?? "",
      /1 queued/u,
    );
    assert.equal(document.querySelectorAll(".queued-messages li").length, 1);
  });
});

test("bulk queue confirmation captures IDs before a later append", async () => {
  await withDom(async (root) => {
    let current: Thread = {
      ...thread([turn()]),
      canonicalItems: [],
      queuedMessages: [],
    };
    const make = (id: string) => ({
      id: `queued-${id}`,
      type: "user_message_queued" as const,
      threadId: current.id,
      clientId: id,
      createdAt: new Date().toISOString(),
      input: [{ type: "text" as const, text: id }],
    });
    for (const id of ["alpha", "beta"])
      current = applyNativeThreadEvent(current, {
        type: "item_completed",
        item: make(id),
      });
    const requests: string[][] = [];
    const show = async () =>
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: emptyComposerState(),
            thread: current,
            onCancelQueued: async (targets) => {
              requests.push(targets.map((item) => item.clientId));
              return {
                results: targets.map((item) => ({
                  ...item,
                  status: "cancelled" as const,
                })),
              };
            },
            onDraftChange: () => undefined,
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
    await show();
    await act(async () =>
      requiredButton(
        '.queued-messages button[title="Cancel this pending message only"]',
      )
        .closest(".queued-messages")
        ?.querySelectorAll("button")
        ?.item(2)
        ?.click(),
    );
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? "",
      /Cancel 2 queued messages/u,
    );
    current = applyNativeThreadEvent(current, {
      type: "item_completed",
      item: make("later"),
    });
    await show();
    assert.match(
      document.querySelector(".queued-messages")?.textContent ?? "",
      /3 queued/u,
    );
    await act(async () =>
      requiredButton('[role="dialog"] button:last-child').click(),
    );
    assert.deepEqual(requests, [["alpha", "beta"]]);
  });
});

test("a message that started before cancellation reports a conflict even after queue projection clears", async () => {
  await withDom(async (root) => {
    let current: Thread = {
      ...thread([turn()]),
      canonicalItems: [],
      queuedMessages: [],
    };
    const queued = {
      id: "queued-race",
      type: "user_message_queued" as const,
      threadId: current.id,
      clientId: "racing-client",
      createdAt: new Date().toISOString(),
      input: [{ type: "text" as const, text: "race" }],
    };
    current = applyNativeThreadEvent(current, {
      type: "item_completed",
      item: queued,
    });
    const show = async () =>
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: emptyComposerState(),
            thread: current,
            onCancelQueued: async (targets) => ({
              results: targets.map((item) => ({
                ...item,
                status: "already_started" as const,
              })),
            }),
            onDraftChange: () => undefined,
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: noop,
          }),
        ),
      );
    await show();
    await act(async () =>
      requiredButton('[aria-label="Cancel queued message 1"]').click(),
    );
    assert.match(
      document.querySelector(".queued-cancel-notice")?.textContent ?? "",
      /already starting or delivered/u,
    );
    current = applyNativeThreadEvent(current, {
      type: "item_completed",
      item: {
        id: "accepted-race",
        type: "user_message",
        threadId: current.id,
        turnId: "turn-1",
        clientId: queued.clientId,
        createdAt: new Date().toISOString(),
        content: queued.input,
      },
    });
    await show();
    assert.equal(document.querySelector(".queued-messages"), null);
    assert.match(
      document.querySelector(".queued-cancel-notice")?.textContent ?? "",
      /cannot be canceled/u,
    );
  });
});

test("pending approvals render in the bottom zone next to the composer", () => {
  const fullCode =
    'const child = await tools.shell({ command: "printf <full>" });\ntext(child.output);';
  const approval = {
    requestId: "approval-1",
    status: "pending",
    decision: null,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      startedAtMs: 1,
      environmentId: null,
      reason: null,
      command: fullCode,
      cwd: "/workspace/with/a/very/long/path/that/must/remain/visible",
      toolName: "run_code",
      toolArguments: { code: fullCode, description: "approval test" },
      commandActions: [],
      proposedExecpolicyAmendment: null,
      networkApprovalContext: null,
      proposedNetworkPolicyAmendments: null,
    },
  } as ApprovalCardState;
  const html = render(true, [approval]);
  assert.match(html, /class="bottom-zone"/u);
  assert.match(html, /class="approval-bar"/u);
  assert.match(html, /Allow the shell-equivalent run_code capability\?/u);
  assert.match(html, /remembered for the stable run_code capability/u);
  assert.match(html, /not granted per command or code segment/u);
  assert.match(html, /printf &lt;full&gt;/u);
  assert.match(html, /very\/long\/path\/that\/must\/remain\/visible/u);
  assert.match(html, /Allow capability/u);
});

test("approval response returns keyboard focus to the composer", async () => {
  await withDom(async (root) => {
    const approval = {
      requestId: "approval-focus",
      status: "pending",
      decision: null,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: null,
        command: "text(42)",
        cwd: "/workspace",
        toolName: "run_code",
        toolArguments: { code: "text(42)", description: "focus" },
        commandActions: [],
        proposedExecpolicyAmendment: null,
        networkApprovalContext: null,
        proposedNetworkPolicyAmendments: null,
      },
    } as ApprovalCardState;
    let decision: string | undefined;
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [approval],
          composer: emptyComposerState(),
          thread: thread([turn()]),
          onDraftChange: () => undefined,
          onInterrupt: noop,
          onRespondToApproval: async (_requestId, value) => {
            decision = value;
          },
          onSubmit: noop,
        }),
      ),
    );
    await act(async () => {
      requiredButton(".approval-actions .allow").click();
      await Promise.resolve();
    });
    assert.equal(decision, "accept");
    assert.equal(document.activeElement?.id, "thread-composer");
  });
});

test("assistant messages omit the identity row while preserving metadata and content", () => {
  const html = renderTurns([
    turnWithItems("completed", [user("request"), agent("Final answer")], 1_000),
  ]);

  assert.doesNotMatch(html, /class="agent-(?:meta|glyph)"/u);
  assert.match(
    html,
    /class="user-row"[\s\S]*<\/article><button class="turn-toggle"[^>]*><span>Worked for 1s<\/span>/u,
  );
  assert.match(html, /class="agent-copy"[\s\S]*Final answer/u);
});

test("completed Turn keeps a steer after its disclosure when collapsed", () => {
  const html = renderTurns([
    turnWithItems(
      "completed",
      [
        user("Initial request", "initial"),
        user("Mid-turn correction", "steer", "tool-1"),
        agent("Checked the first result."),
        commandItem("tool-1", "rg deliveryAfter"),
        agent("Final corrected answer."),
      ],
      1_000,
    ),
  ]);

  assert.ok(html.indexOf("Initial request") < html.indexOf("turn-toggle"));
  assert.ok(html.indexOf("turn-toggle") < html.indexOf("Mid-turn correction"));
  assert.ok(
    html.indexOf("Mid-turn correction") <
      html.indexOf("Final corrected answer."),
  );
});

test("expanded Turn renders a steer at its delivery point", async () => {
  await withDom(async (root) => {
    await renderInteractive(
      root,
      turnWithItems("completed", [
        user("Initial request", "initial"),
        user("Mid-turn correction", "steer", "tool-1"),
        agent("Checked the first result."),
        commandItem("tool-1", "rg deliveryAfter"),
        agent("Applied the correction."),
        agent("Final corrected answer."),
      ]),
    );
    await act(async () => requiredButton(".turn-toggle").click());

    const text = document.querySelector(".turn")?.textContent ?? "";
    assert.ok(
      text.indexOf("Initial request") <
        text.indexOf("Checked the first result."),
    );
    assert.ok(
      text.indexOf("Checked the first result.") <
        text.indexOf("Mid-turn correction"),
    );
    assert.ok(
      text.indexOf("Mid-turn correction") <
        text.indexOf("Applied the correction."),
    );
    assert.ok(
      text.indexOf("Applied the correction.") <
        text.indexOf("Final corrected answer."),
    );
  });
});

test("message controls are Turn-backed, accessible, and stable while hovering", () => {
  const completedAt = new Date();
  completedAt.setHours(12, 34, 0, 0);
  const html = renderTurns([
    {
      ...turnWithItems(
        "completed",
        [user("Copy this *raw* Markdown"), agent("Answer")],
        1_000,
      ),
      completedAt: Math.floor(completedAt.getTime() / 1_000),
    },
  ]);

  assert.match(html, /class="message-actions user-message-actions"/u);
  assert.match(html, /aria-label="Copy user message"/u);
  assert.match(html, /class="message-actions assistant-message-actions"/u);
  assert.match(html, /aria-label="Copy assistant message"/u);
  assert.equal((html.match(/data-icon="copy"/gu) ?? []).length, 2);
  assert.doesNotMatch(html, />Copy<|>Completed /u);
  assert.equal((html.match(/class="message-time"/gu) ?? []).length, 2);
  const todayTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(completedAt);
  assert.equal(
    (html.match(new RegExp(`>${todayTime}</time>`, "gu")) ?? []).length,
    2,
  );
});

test("Turn disclosure does not repeat cache telemetry from assistant actions", () => {
  const html = renderTurns(
    [turnWithItems("completed", [user("request"), agent("Done")], 1_000)],
    [],
    emptyComposerState(),
    {},
    {
      thread: {
        responseCount: 1,
        inputTokens: 150,
        cachedInputTokens: 40,
        outputTokens: 17,
        cacheHitRate: 0.4,
      },
      turns: {
        "turn-1": {
          responseCount: 1,
          inputTokens: 150,
          cachedInputTokens: 40,
          outputTokens: 17,
          cacheHitRate: 0.4,
        },
      },
      context: {
        inputTokens: 150,
        inputTokenSource: "provider",
        contextWindow: null,
        ratio: null,
      },
    },
  );
  const disclosure = html.match(
    /<button class="turn-toggle"[\s\S]*?<\/button>/u,
  )?.[0];

  assert.ok(disclosure);
  assert.doesNotMatch(disclosure, /Cache/u);
  assert.equal((html.match(/Cache 40% · 150 in · 17 out/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /class="turn-usage"/u);
});

test("only the final assistant message exposes metadata and hover actions", async () => {
  await withDom(async (root) => {
    await renderInteractive(
      root,
      turnWithItems(
        "completed",
        [
          user("request"),
          agent("Intermediate update"),
          reasoning("Checked the result"),
          agent("Final answer"),
        ],
        1_000,
      ),
      {
        thread: {
          responseCount: 1,
          inputTokens: 150,
          cachedInputTokens: 40,
          outputTokens: 17,
          cacheHitRate: 0.4,
        },
        turns: {
          "turn-1": {
            responseCount: 1,
            inputTokens: 150,
            cachedInputTokens: 40,
            outputTokens: 17,
            cacheHitRate: 0.4,
          },
        },
        context: {
          inputTokens: 150,
          inputTokenSource: "provider",
          contextWindow: null,
          ratio: null,
        },
      },
    );
    await act(async () => requiredButton(".turn-toggle").click());

    const messages = document.querySelectorAll(".agent-copy");
    assert.equal(messages.length, 2);
    assert.match(messages[0]?.textContent ?? "", /Intermediate update/u);
    assert.equal(messages[0]?.querySelector(".message-actions"), null);
    assert.match(messages[1]?.textContent ?? "", /Final answer/u);
    assert.ok(messages[1]?.querySelector(".assistant-message-actions"));
    assert.equal(
      document.querySelectorAll(".assistant-message-actions .message-cache")
        .length,
      1,
    );
  });
});

test("running Turns do not invent a completion timestamp in message controls", () => {
  const html = renderTurns([
    turnWithItems("inProgress", [user("Still running"), agent("Partial")]),
  ]);

  assert.match(html, /class="message-actions user-message-actions"/u);
  assert.doesNotMatch(html, /class="message-time"/u);
  assert.match(html, /aria-label="Copy user message"/u);
});

test("terminal Turn timestamps show time only today and add a date across local days", () => {
  const today = new Date();
  today.setHours(12, 34, 0, 0);
  const todayTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(today);
  for (const status of ["completed", "interrupted", "failed"] as const) {
    const html = renderTurns([
      {
        ...turnWithItems(status, [user(`${status} request`), agent(status)]),
        completedAt: Math.floor(today.getTime() / 1_000),
      },
    ]);

    assert.equal(
      (html.match(new RegExp(`>${todayTime}</time>`, "gu")) ?? []).length,
      2,
    );
    assert.doesNotMatch(html, />(?:Completed|Interrupted|Failed) /u);
  }

  const otherDay = new Date(today);
  otherDay.setDate(today.getDate() === 1 ? 2 : today.getDate() - 1);
  const otherDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(otherDay);
  const otherTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(otherDay);
  const html = renderTurns([
    {
      ...turnWithItems("completed", [user("Earlier"), agent("Earlier answer")]),
      completedAt: Math.floor(otherDay.getTime() / 1_000),
    },
  ]);
  assert.equal(
    (html.match(new RegExp(`>${otherDate} ${otherTime}</time>`, "gu")) ?? [])
      .length,
    2,
  );
});

test("reasoning detail uses the safe Markdown renderer", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem(
        "reasoning-markdown",
        ["Reasoning"],
        ["**bold**\n\n`code`"],
      ),
    );
    await act(async () => requiredButton(".trace-item-toggle").click());
    const detail = requiredElement(".trace-detail");
    assert.match(detail.innerHTML, /<strong>bold<\/strong>/u);
    assert.match(detail.innerHTML, /<code>code<\/code>/u);
  });
});

test("assistant messages omit the identity row while preserving metadata and content", () => {
  const html = renderTurns([
    turnWithItems("completed", [user("request"), agent("Final answer")], 1_000),
  ]);

  assert.doesNotMatch(html, /class="agent-(?:meta|glyph)"/u);
  assert.match(
    html,
    /class="user-row"[\s\S]*<\/article><button class="turn-toggle"[^>]*><span>Worked for 1s<\/span>/u,
  );
  assert.match(html, /class="agent-copy"[\s\S]*Final answer/u);
});

test("renders compact token-weighted cache usage for each Turn, not the message body", () => {
  const html = renderTurns(
    [
      turnWithItems("completed", [user("request"), agent("Done")], 1_000),
      { ...turnWithItems("completed", [agent("Again")]), id: "turn-2" },
    ],
    [],
    emptyComposerState(),
    {},
    {
      thread: {
        responseCount: 3,
        inputTokens: 200,
        cachedInputTokens: 50,
        outputTokens: 25,
        cacheHitRate: 1 / 3,
      },
      turns: {
        "turn-1": {
          responseCount: 2,
          inputTokens: 150,
          cachedInputTokens: 40,
          outputTokens: 17,
          cacheHitRate: 0.4,
        },
        "turn-2": {
          responseCount: 1,
          inputTokens: 50,
          outputTokens: 8,
        },
      },
      context: {
        inputTokens: 50,
        inputTokenSource: "provider",
        contextWindow: null,
        ratio: null,
      },
    },
  );

  assert.doesNotMatch(html, /Thread cache 33% · 200 in · 25 out/u);
  assert.match(html, /Cache 40% · 150 in · 17 out/u);
  assert.match(html, /Cache unknown · 50 in · 8 out/u);
  assert.doesNotMatch(html, /Cache 0% · 50 in/u);
});

test("assistant messages retain running reasoning and tool disclosure affordances", () => {
  const html = renderTurns([
    turnWithItems("inProgress", [
      user("Inspect the project"),
      agent("Checking the relevant files."),
      reasoning("Mapped the rendering path"),
      command("rg ThreadView"),
    ]),
  ]);

  assert.doesNotMatch(html, /class="agent-(?:meta|glyph)"/u);
  assert.match(html, /class="turn-running-label"[\s\S]*Working/u);
  assert.match(html, /Checking the relevant files\./u);
  assert.match(
    html,
    /class="trace-toggle"[^>]*aria-expanded="false"[\s\S]*rg ThreadView[\s\S]*2 items/u,
  );
});

test("renders one trace Item directly and wraps only a sequence of two or more", () => {
  const singleton = renderTurns([
    turnWithItems("inProgress", [reasoning("Mapped the rendering path")]),
  ]);
  assert.match(singleton, /class="trace-item trace-singleton"/u);
  assert.doesNotMatch(singleton, /class="trace-group"/u);
  assert.doesNotMatch(singleton, /[>]1 items[<]/u);

  const grouped = renderTurns([
    turnWithItems("inProgress", [
      reasoning("Mapped the rendering path"),
      command("rg ThreadView"),
    ]),
  ]);
  assert.match(grouped, /class="trace-group"/u);
  assert.match(grouped, /[>]2 items[<]/u);
});

test("renders canonical run_code children as nested rows with full code", async () => {
  await withDom(async (root) => {
    const fullCode =
      'const child = await tools.shell({ command: "printf nested" });\ntext(child.output);';
    const outer = {
      ...commandItem("outer-item", fullCode),
      toolName: "run_code",
      toolArguments: { code: fullCode, description: "Inspect nested output" },
      callId: "outer-call",
    };
    const child = {
      ...commandItem("child-item", "printf nested"),
      toolName: "shell",
      toolArguments: { command: "printf nested" },
      callId: "child-call",
      parentCallId: "outer-call",
    };
    await renderInteractive(root, turnWithItems("inProgress", [outer, child]));
    await act(async () => requiredButton(".trace-toggle").click());

    const nested = requiredElement(".trace-item-nested");
    assert.equal(
      nested.getAttribute("aria-label"),
      "Nested tool invoked by run_code",
    );
    const outerToggle = document.querySelectorAll<HTMLButtonElement>(
      ".trace-items .trace-item-toggle",
    )[0];
    assert.ok(outerToggle);
    await act(async () => outerToggle.click());
    assert.equal(
      requiredElement(".trace-input-preview code").textContent,
      fullCode,
    );
    assert.match(document.body.textContent ?? "", /Inspect nested output/u);
  });
});

test("tool and group disclosures remain mounted, inert when closed, and stable across streamed updates", async () => {
  await withDom(async (root) => {
    const first = commandItem("motion-one", "printf first") as Extract<
      ThreadItem,
      { type: "commandExecution" }
    >;
    const second = commandItem("motion-two", "printf second");
    await renderInteractive(root, turnWithItems("inProgress", [first, second]));
    const group = requiredButton(".trace-toggle");
    const groupReveal = requiredElement(".trace-group > .trace-reveal");
    assert.equal(groupReveal.getAttribute("aria-hidden"), "true");
    assert.equal(groupReveal.hasAttribute("inert"), true);
    await act(async () => group.click());
    assert.equal(group.getAttribute("aria-expanded"), "true");
    assert.equal(groupReveal.getAttribute("aria-hidden"), "false");
    assert.equal(groupReveal.hasAttribute("inert"), false);
    const item = requiredButton(".trace-items .trace-item-toggle");
    const itemReveal = requiredElement(
      ".trace-items .trace-item .trace-reveal",
    );
    await act(async () => item.click());
    assert.equal(item.getAttribute("aria-expanded"), "true");
    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        { ...first, aggregatedOutput: "streamed output" },
        second,
      ]),
    );
    assert.equal(
      requiredElement(".trace-items .trace-item .trace-reveal"),
      itemReveal,
    );
    assert.equal(itemReveal.dataset.open, "true");
    await act(async () => {
      item.click();
      item.click();
      item.click();
    });
    assert.equal(itemReveal.dataset.open, "false");
    assert.equal(itemReveal.hasAttribute("inert"), true);
    await act(async () => {
      group.click();
      group.click();
    });
    assert.equal(groupReveal.dataset.open, "true");
    assert.equal(requiredElement(".trace-group > .trace-reveal"), groupReveal);
  });
});

test("singleton promotion preserves its disclosure and focused button", async () => {
  await withDom(async (root) => {
    const first = reasoningItem(
      "reasoning-promote",
      ["Mapped the rendering path"],
      ["Public reasoning"],
    );
    await renderInteractive(root, turnWithItems("inProgress", [first]));
    const singletonToggle = requiredButton(".trace-singleton > button");
    singletonToggle.focus();
    await act(async () => singletonToggle.click());
    assert.equal(singletonToggle.getAttribute("aria-expanded"), "true");

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-promote", "rg ThreadView"),
      ]),
    );
    const groupToggle = requiredButton(".trace-group > .trace-toggle");
    assert.equal(groupToggle, singletonToggle);
    assert.equal(document.activeElement, groupToggle);
    assert.equal(groupToggle.getAttribute("aria-expanded"), "true");
    assert.equal(
      requiredElement(".trace-group .trace-item .trace-detail").textContent,
      "Public reasoning",
    );

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoningItem(
          "reasoning-promote",
          ["Mapped the rendering path"],
          ["Updated public reasoning"],
        ),
        commandItem("command-promote", "rg ThreadView"),
      ]),
    );
    assert.equal(requiredButton(".trace-group > .trace-toggle"), groupToggle);
    assert.equal(document.activeElement, groupToggle);
    assert.equal(
      requiredElement(".trace-group .trace-item .trace-detail").textContent,
      "Updated public reasoning",
    );
  });
});

test("tool singleton promotion preserves its open detail", async () => {
  await withDom(async (root) => {
    const first = commandItem("command-promote-first", "rg ThreadView");
    await renderInteractive(root, turnWithItems("inProgress", [first]));
    await act(async () => requiredButton(".trace-singleton > button").click());

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        reasoningItem("reasoning-promote-second", ["Mapped"], []),
      ]),
    );
    const detail = requiredElement(".trace-group .trace-item .trace-detail");
    assert.equal(requiredWithin(detail, "code").textContent, "rg ThreadView");
    assert.match(detail.textContent ?? "", /ThreadView\.tsx/u);
  });
});

test("collapsed singleton promotes to a collapsed trace group", async () => {
  await withDom(async (root) => {
    const first = reasoningItem(
      "reasoning-promote-closed",
      ["Mapped the rendering path"],
      ["Public reasoning"],
    );
    await renderInteractive(root, turnWithItems("inProgress", [first]));
    assert.equal(
      requiredButton(".trace-singleton > button").getAttribute("aria-expanded"),
      "false",
    );

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-promote-closed", "rg ThreadView"),
      ]),
    );
    assert.equal(
      requiredButton(".trace-group > .trace-toggle").getAttribute(
        "aria-expanded",
      ),
      "false",
    );
  });
});

test("streaming append preserves an explicitly closed trace group", async () => {
  await withDom(async (root) => {
    const first = reasoningItem("reasoning-close", ["Mapped"], []);
    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-close-a", "rg ThreadView"),
      ]),
    );
    const toggle = requiredButton(".trace-toggle");
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    toggle.focus();

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        first,
        commandItem("command-close-a", "rg ThreadView"),
        commandItem("command-close-b", "npm test"),
      ]),
    );
    const updated = requiredButton(".trace-toggle");
    assert.equal(updated, toggle);
    assert.equal(document.activeElement, updated);
    assert.equal(updated.getAttribute("aria-expanded"), "false");
  });
});

test("terminal transition folds intermediate trace before Turn history reopens", async () => {
  await withDom(async (root) => {
    const items = [
      reasoningItem("reasoning-terminal", ["Mapped"], []),
      commandItem("command-terminal", "npm test"),
    ];
    await renderInteractive(root, turnWithItems("inProgress", items));
    await act(async () => requiredButton(".trace-toggle").click());
    assert.equal(
      requiredButton(".trace-toggle").getAttribute("aria-expanded"),
      "true",
    );

    await renderInteractive(
      root,
      turnWithItems("completed", [...items, agent("Done")]),
    );
    assert.equal(document.querySelector(".trace-toggle"), null);
    await act(async () => requiredButton(".turn-toggle").click());
    assert.equal(
      requiredButton(".trace-toggle").getAttribute("aria-expanded"),
      "false",
    );
  });
});

test("public reasoning with a summary expands from summary to full content", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem(
        "reasoning-public-summary",
        ["Provider summary"],
        ["Full public reasoning"],
      ),
    );
    const toggle = requiredWithin<HTMLButtonElement>(
      row,
      ":scope > .trace-item-toggle",
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      requiredWithin(toggle, ":scope > span").textContent,
      "Provider summary",
    );

    await act(async () => toggle.click());
    const detail = requiredWithin(row, ":scope > .trace-reveal .trace-detail");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(detail.textContent, "Full public reasoning");
    assert.doesNotMatch(detail.textContent ?? "", /Provider summary/u);
  });
});

test("projected public reasoning keeps its summary label and expandable content", async () => {
  const projected = projectCompletedItem({
    type: "reasoning",
    id: "reasoning-projected-public-summary",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: "2026-08-27T00:00:00.000Z",
    reasoningContent: "Projected public reasoning",
    summary: "Projected provider summary",
    contentVisibility: "public",
  });
  assert.ok(projected?.type === "reasoning");

  await withDom(async (root) => {
    const row = await openReasoningRow(root, projected);
    const toggle = requiredWithin<HTMLButtonElement>(
      row,
      ":scope > .trace-item-toggle",
    );
    assert.equal(
      requiredWithin(toggle, ":scope > span").textContent,
      "Projected provider summary",
    );

    await act(async () => toggle.click());
    assert.equal(
      requiredWithin(row, ":scope > .trace-reveal .trace-detail").textContent,
      "Projected public reasoning",
    );
  });
});

test("public reasoning without a summary keeps a neutral expandable label", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem("reasoning-public", [], ["Full public reasoning"]),
    );
    const toggle = requiredWithin<HTMLButtonElement>(
      row,
      ":scope > .trace-item-toggle",
    );
    assert.equal(
      requiredWithin(toggle, ":scope > span").textContent,
      "Thought",
    );

    await act(async () => toggle.click());
    assert.equal(
      requiredWithin(row, ":scope > .trace-reveal .trace-detail").textContent,
      "Full public reasoning",
    );
  });
});

test("opaque reasoning with a summary is a static summary row", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem("reasoning-opaque-summary", ["Provider summary"], []),
    );
    const label = requiredWithin(row, ":scope > .trace-item-static > span");
    assert.equal(label.textContent, "Provider summary");
    assert.equal(row.querySelector(":scope > button"), null);
    assert.equal(row.querySelector("[aria-expanded]"), null);
    assert.equal(row.querySelector('[data-icon="chevron-down"]'), null);
    assert.equal(row.querySelector(".trace-detail"), null);
  });
});

test("adjacent no-details reasoning shares an honest count while tools and public summaries remain in order", async () => {
  await withDom(async (root) => {
    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoningItem("opaque-a", [], []),
        reasoningItem("opaque-b", [], []),
        commandItem("tool-between", "shell"),
        reasoningItem("opaque-c", [], []),
        reasoningItem("public-summary", ["Public summary"], []),
        reasoningItem("opaque-d", [], []),
        reasoningItem("opaque-e", [], []),
      ]),
    );
    await act(async () => requiredButton(".trace-toggle").click());
    const details = requiredElement(".trace-items");
    const rows = [...details.children].map((row) => row.textContent ?? "");
    assert.equal(rows.length, 2);
    assert.match(rows[0]!, /Shell/u);
    assert.match(rows[1]!, /Public summary/u);
    assert.equal(
      details.querySelectorAll(".trace-reasoning-without-details").length,
      0,
    );
    assert.equal(
      details.querySelectorAll(".trace-reasoning-without-details button")
        .length,
      0,
    );
  });
});

test("opaque reasoning without a summary exposes only a neutral static row", async () => {
  await withDom(async (root) => {
    const row = await openReasoningRow(
      root,
      reasoningItem("reasoning-opaque", [], []),
    );
    assert.equal(
      requiredWithin(row, ":scope > .trace-item-static > span").textContent,
      "Thought",
    );
    assert.equal(row.querySelector(":scope > button"), null);
    assert.equal(row.querySelector("[aria-expanded]"), null);
    assert.equal(row.querySelector('[data-icon="chevron-down"]'), null);
    assert.equal(row.querySelector(".trace-detail"), null);
  });
});

test("streamed public content turns a static row into an expandable completed item", async () => {
  await withDom(async (root) => {
    const id = "reasoning-stream";
    await renderInteractive(
      root,
      turnWithItems("inProgress", [reasoningItem(id, [], [])]),
    );
    assert.ok(document.querySelector(".trace-item-static"));
    assert.equal(document.querySelector(".trace-item-toggle"), null);

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoningItem(id, [], ["Streaming public reasoning"]),
      ]),
    );
    assert.equal(
      requiredButton(".trace-item-toggle").getAttribute("aria-expanded"),
      "false",
    );

    await renderInteractive(
      root,
      turnWithItems("completed", [
        reasoningItem(id, [], ["Streaming public reasoning"]),
      ]),
    );
    await act(async () => requiredButton(".turn-toggle").click());
    const toggle = requiredButton(".trace-item-toggle");
    await act(async () => toggle.click());
    assert.equal(
      requiredElement(".trace-detail").textContent,
      "Streaming public reasoning",
    );
  });
});

test("resumed user messages expose canonical attachments with accessible preview names", () => {
  const html = renderTurns(
    [turnWithItems("completed", [user(""), agent("Seen")])],
    [],
    emptyComposerState(),
    {
      "user-1": [
        {
          type: "attachment",
          sha256: "a".repeat(64),
          mediaType: "image/png",
          byteLength: 68,
          width: 1,
          height: 1,
        },
      ],
    },
  );
  assert.match(html, /aria-label="Attached images"/u);
  assert.match(html, /aria-label="Preview Attached image 1"/u);
  assert.doesNotMatch(html, /base64|\/tmp\//u);
  // An image-only transcript message renders standalone thumbnails and no
  // text bubble; attachments are never wrapped inside the bubble itself.
  assert.doesNotMatch(html, /class="user-bubble"/u);
  assert.ok(
    html.indexOf('aria-label="Attached images"') <
      html.indexOf('aria-label="Preview Attached image 1"'),
  );
});

test("images precede text in Composer and transcript, including image-only messages", () => {
  const first: AttachmentRef = {
    type: "attachment",
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 4,
    width: 1,
    height: 1,
  };
  const second: AttachmentRef = { ...first, sha256: "b".repeat(64) };
  const composer = addComposerImages(
    editComposer(emptyComposerState(), "line one\nline two"),
    [
      { id: "draft-a", name: "first.png", attachment: first },
      { id: "draft-b", name: "second.png", attachment: second },
    ],
  );
  const composerHtml = renderTurns([], [], composer);
  assert.ok(
    composerHtml.indexOf('class="composer-images"') <
      composerHtml.indexOf('id="thread-composer"'),
  );
  assert.ok(
    composerHtml.indexOf("first.png") < composerHtml.indexOf("second.png"),
  );

  const transcriptHtml = renderTurns(
    [turnWithItems("completed", [user("line one\nline two"), agent("Seen")])],
    [],
    emptyComposerState(),
    { "user-1": [first, second] },
  );
  assert.ok(
    transcriptHtml.indexOf('class="message-images"') <
      transcriptHtml.indexOf('class="user-bubble"'),
  );
  assert.ok(
    transcriptHtml.indexOf('class="user-bubble"') <
      transcriptHtml.indexOf("line one"),
  );
  assert.ok(
    transcriptHtml.indexOf('aria-label="Preview Attached image 1"') <
      transcriptHtml.indexOf('aria-label="Preview Attached image 2"'),
  );

  const imageOnlyHtml = renderTurns(
    [turnWithItems("completed", [user(""), agent("Seen")])],
    [],
    emptyComposerState(),
    { "user-1": [first] },
  );
  assert.match(imageOnlyHtml, /class="message-images"/u);
  // Without text there is no empty bubble behind the standalone thumbnails.
  assert.doesNotMatch(imageOnlyHtml, /class="user-bubble"/u);
});

function render(
  active: boolean,
  approvals: readonly ApprovalCardState[],
  composer: ComposerState = emptyComposerState(),
) {
  return renderTurns(active ? [turn()] : [], approvals, composer);
}

function renderTurns(
  turns: Turn[],
  approvals: readonly ApprovalCardState[] = [],
  composer: ComposerState = emptyComposerState(),
  threadAttachments: Parameters<typeof ThreadView>[0]["threadAttachments"] = {},
  threadUsage?: ModelUsageProjection,
) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      approvals,
      composer,
      thread: thread(turns),
      threadAttachments,
      threadUsage,
      onDraftChange: () => undefined,
      onInterrupt: noop,
      onRespondToApproval: noop,
      onSubmit: noop,
    }),
  );
}

function usageProjection(): ModelUsageProjection {
  return {
    thread: { responseCount: 1, inputTokens: 10, outputTokens: 2 },
    turns: {},
    context: {
      inputTokens: 78_200,
      inputTokenSource: "estimated",
      contextWindow: 262_000,
      ratio: 0.3,
    },
  };
}

function compactionHistory(): CanonicalItem[] {
  return [
    {
      id: "metadata-1",
      type: "thread_metadata",
      threadId: "thread-1",
      createdAt: "2026-09-20T09:00:00Z",
      cwd: "/workspace",
      providerProfileId: "openai",
      modelId: "test-model",
      reasoningEffort: null,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    {
      id: "started-1",
      type: "turn_started",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-20T09:00:01Z",
      selection: {
        providerProfileId: "openai",
        modelId: "test-model",
        reasoningEffort: null,
      },
    },
    {
      id: "user-1",
      type: "user_message",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-20T09:00:02Z",
      content: [{ type: "text", text: "Keep this request" }],
    },
    {
      id: "agent-1",
      type: "agent_message",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-20T09:00:03Z",
      text: "Kept answer",
    },
    {
      id: "completed-1",
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-20T09:00:04Z",
      status: "completed",
    },
    {
      id: "compact-1",
      type: "context_compaction",
      threadId: "thread-1",
      createdAt: "2026-09-20T09:00:05Z",
      provenance: "provider_generated",
      initiator: "human",
      coveredThroughItemId: "completed-1",
      summary: "Continue with the accepted plan",
      retainedItemIds: ["user-1", "agent-1"],
      providerProfileId: "openai",
      modelId: "test-model",
      reasoningEffort: null,
      algorithmVersion: "zen.context-compaction.v2",
      tokenUsage: { inputTokens: 25, outputTokens: 8 },
    },
  ];
}

function domTextAreaPrototype(): typeof HTMLTextAreaElement.prototype {
  return window.HTMLTextAreaElement.prototype;
}

async function openReasoningRow(
  root: Root,
  item: Extract<ThreadItem, { type: "reasoning" }>,
): Promise<HTMLElement> {
  await renderInteractive(root, turnWithItems("inProgress", [item]));
  return requiredElement<HTMLElement>(".trace-singleton");
}

async function renderInteractive(
  root: Root,
  value: Turn,
  threadUsage?: ModelUsageProjection,
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ThreadView, {
        approvals: [],
        composer: emptyComposerState(),
        thread: thread([value]),
        threadUsage,
        onDraftChange: () => undefined,
        onInterrupt: noop,
        onRespondToApproval: noop,
        onSubmit: noop,
      }),
    ),
  );
}

async function withDom(run: (root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

function requiredButton(selector: string): HTMLButtonElement {
  return requiredElement<HTMLButtonElement>(selector);
}

function requiredElement<T extends Element = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  assert.ok(value, `Expected ${selector}`);
  return value;
}

function requiredWithin<T extends Element = HTMLElement>(
  parent: ParentNode,
  selector: string,
): T {
  const value = parent.querySelector<T>(selector);
  assert.ok(value, `Expected ${selector}`);
  return value;
}

function thread(turns: Turn[]): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: 10,
    updatedAt: 10,
    recencyAt: null,
    status:
      turns.length === 0
        ? { type: "idle" }
        : { type: "active", activeFlags: [] },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function turn(): Turn {
  return turnWithItems("inProgress", []);
}

function turnWithItems(
  status: Turn["status"],
  items: ThreadItem[],
  durationMs: number | null = null,
): Turn {
  return {
    id: "turn-1",
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 10,
    completedAt: status === "inProgress" ? null : 11,
    durationMs,
  };
}

function user(text: string, id = "user-1", deliveryAfter?: string): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
    ...(deliveryAfter === undefined ? {} : { deliveryAfter }),
  } as ThreadItem;
}

function agent(text: string): ThreadItem {
  return {
    type: "agentMessage",
    id: `agent-${text}`,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function reasoning(summary: string): ThreadItem {
  return {
    type: "reasoning",
    id: "reasoning-1",
    summary: [summary],
    content: [],
  };
}

function reasoningItem(
  id: string,
  summary: string[],
  content: string[],
): Extract<ThreadItem, { type: "reasoning" }> {
  return { type: "reasoning", id, summary, content };
}

function command(value: string): ThreadItem {
  return commandItem("command-1", value);
}

function commandItem(id: string, value: string): ThreadItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: value,
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "ThreadView.tsx",
    exitCode: 0,
    durationMs: null,
  };
}

test("failed turn opens received trace and preserves the error without a final answer", () => {
  const failed = turnWithItems("failed", [
    user("request"),
    reasoning("Observed trace"),
    agent("Partial answer"),
  ]);
  failed.error = {
    message: "invalid tool call id",
    codexErrorInfo: null,
    additionalDetails: null,
  };
  const document = new JSDOM(renderTurns([failed])).window.document;
  assert.equal(
    document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
    "true",
  );
  assert.match(
    document.querySelector(".turn-history")?.textContent ?? "",
    /Partial answer/u,
  );
  assert.match(
    document.querySelector(".turn-history")?.textContent ?? "",
    /Observed trace/u,
  );
  assert.equal(document.querySelector(".turn-final"), null);
  assert.equal(
    document.querySelector(".turn-terminal")?.textContent,
    "invalid tool call id",
  );
});

test("keyboard modifiers and send button honor all running send modes", async () => {
  await withDom(async (root) => {
    for (const [mode, normal, alternate] of [
      ["batch", "batch-next", "steer"],
      ["queue", "queue", "steer"],
      ["soft", "steer", "batch-next"],
      ["hard", "replace", "batch-next"],
    ] as const) {
      const intents: string[] = [];
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            composerSendMode: mode,
            approvals: [],
            composer: editComposer(emptyComposerState(), "follow up"),
            thread: thread([turnWithItems("inProgress", [])]),
            onDraftChange: () => undefined,
            onInterrupt: noop,
            onRespondToApproval: noop,
            onSubmit: async (intent) => {
              intents.push(intent);
            },
          }),
        ),
      );
      const textarea = document.querySelector("textarea")!;
      await act(async () => {
        textarea.focus();
        textarea.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      await act(async () => {
        textarea.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            bubbles: true,
          }),
        );
      });
      await act(async () => {
        textarea.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });
      await act(async () => requiredButton(".action-orb").click());
      await act(async () => {
        textarea.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            shiftKey: true,
            bubbles: true,
          }),
        );
      });
      assert.deepEqual(intents, [normal, alternate, alternate, normal]);
    }
  });
});

test("shell headings and pending calls do not claim that a started call is running", async () => {
  await withDom(async (root) => {
    const base = commandItem("shell-start", "sleep 10");
    assert.equal(base.type, "commandExecution");
    if (base.type !== "commandExecution") return;
    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        {
          ...base,
          toolName: "shell",
          status: "inProgress",
          toolArguments: { command: "sleep 10" },
        },
      ]),
    );
    assert.match(
      requiredElement(".trace-item-toggle").textContent ?? "",
      /Shell/,
    );
    assert.equal(requiredElement(".tool-status").textContent, "Started");
    assert.equal(document.querySelector(".trace-item .mini-spinner"), null);
  });
});

test("public reasoning content without a summary has an honest heading", () => {
  const html = renderTurns([
    turnWithItems("inProgress", [
      reasoningItem("public-reason", [], ["Visible thought"]),
    ]),
  ]);
  assert.match(html, />Thought</u);
  assert.doesNotMatch(html, /Think[\s\S]*Reasoning/u);
  assert.doesNotMatch(html, /Reasoning details/u);
});

test("yielded shell work reports the actual task receipt phase", async () => {
  await withDom(async (root) => {
    const base = commandItem("shell-start", "npm run dev");
    assert.equal(base.type, "commandExecution");
    if (base.type !== "commandExecution") return;
    const running = {
      ...base,
      toolName: "shell",
      contentType: "application/vnd.zen.tool-task+json",
      structuredContent: {
        status: "running",
        task_id: "session-one",
        exit_code: null,
      },
      aggregatedOutput: "Command is still running",
    };
    await renderInteractive(root, turnWithItems("inProgress", [running]));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".trace-toggle")?.click(),
    );
    assert.equal(
      document.querySelector(".tool-status")?.textContent,
      "Running",
    );
    await renderInteractive(
      root,
      turnWithItems("inProgress", [{ ...running, toolName: "wait" }]),
    );
    assert.equal(
      document.querySelector(".tool-status")?.textContent,
      "Waiting",
    );
    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        {
          ...running,
          toolName: "wait",
          status: "failed",
          exitCode: 124,
          structuredContent: {
            status: "timed_out",
            task_id: "session-one",
            exit_code: 124,
          },
        },
      ]),
    );
    assert.equal(
      document.querySelector(".tool-status")?.textContent,
      "Timed out",
    );
  });
});

test("folded task group and expanded wait row use the same receipt phase", async () => {
  await withDom(async (root) => {
    const base = commandItem("wait-item", "wait");
    if (base.type !== "commandExecution") throw new Error("missing command");
    const wait = {
      ...base,
      toolName: "wait",
      contentType: "application/vnd.zen.tool-task+json",
      structuredContent: { status: "running" },
    };
    const reasoning = reasoningItem("reason-wait", [], ["Waiting for task"]);
    await renderInteractive(
      root,
      turnWithItems("inProgress", [reasoning, wait]),
    );
    const group = requiredButton(".trace-toggle");
    assert.equal(group.getAttribute("aria-expanded"), "false");
    assert.match(group.textContent ?? "", /Waiting for task/u);
    await act(async () => group.click());
    assert.equal(group.getAttribute("aria-expanded"), "true");
    assert.equal(
      requiredElement(".trace-items .tool-status").textContent,
      "Waiting",
    );

    await renderInteractive(
      root,
      turnWithItems("inProgress", [
        reasoning,
        { ...wait, structuredContent: { status: "timed_out" } },
      ]),
    );
    assert.match(group.textContent ?? "", /Wait · timed out/u);
    assert.equal(
      requiredElement(".trace-items .tool-status").textContent,
      "Timed out",
    );
    await act(async () => group.click());
    assert.equal(group.getAttribute("aria-expanded"), "false");
  });
});

test("generic tool task observations distinguish waiting and unconfirmed cancellation", async () => {
  await withDom(async (root) => {
    const base = commandItem("image-task", "generate image");
    if (base.type !== "commandExecution") throw new Error("missing command");
    const cases = [
      ["browser_click", "queued", "Queued"],
      ["wait", "queued", "Queued"],
      ["image_generate", "running", "Running"],
      ["wait", "running", "Waiting"],
      ["wait", "cancel_requested", "Cancelling"],
      ["wait", "cancellation_unconfirmed", "Cancellation unconfirmed"],
      ["wait", "cancelled", "Cancelled"],
      ["wait", "timed_out", "Timed out"],
      ["wait", "failed", "Failed"],
      ["wait", "completed", "Waited"],
    ] as const;
    for (const [toolName, status, expected] of cases) {
      await renderInteractive(
        root,
        turnWithItems("inProgress", [
          {
            ...base,
            toolName,
            contentType: "application/vnd.zen.tool-task+json",
            structuredContent: {
              status,
              task_id: "task-image",
              exit_code: null,
            },
            aggregatedOutput: "Existing partial output",
          },
        ]),
      );
      if (!document.querySelector(".tool-status")) {
        await act(async () =>
          document.querySelector<HTMLButtonElement>(".trace-toggle")?.click(),
        );
      }
      assert.equal(
        document.querySelector(".tool-status")?.textContent,
        expected,
      );
    }
  });
});

test("Think reserves the status column and uses live or interrupted state without Done", async () => {
  await withDom(async (root) => {
    const item = {
      ...reasoningItem("thinking-status", ["Thought"], ["Retained thought"]),
      status: "inProgress",
    };
    await openReasoningRow(root, item as ReturnType<typeof reasoningItem>);
    assert.ok(
      document.querySelector('.trace-item-status [aria-label="Thinking"]'),
    );
    assert.ok(document.querySelector(".trace-item-chevron"));
    assert.doesNotMatch(
      requiredElement(".trace-item-toggle").textContent ?? "",
      /Done/,
    );
  });
});

test("partial canonical reasoning remains visibly interrupted after reopening", () => {
  const item = projectCompletedItem({
    id: "partial-thought",
    threadId: "t",
    turnId: "r",
    createdAt: "2026-09-08T00:00:00.000Z",
    type: "reasoning",
    reasoningContent: "partial",
    contentVisibility: "public",
    incomplete: true,
  });
  assert.ok(item?.type === "reasoning");
  assert.equal((item as { status?: string }).status, "interrupted");
});

test("tool images appear only inside expanded tool details beside unchanged call and output", async () => {
  await withDom(async (root) => {
    const value = commandItem(
      "view-call",
      'view_image {"path":"/tmp/image.png"}',
    );
    assert.equal(value.type, "commandExecution");
    if (value.type !== "commandExecution") return;
    value.aggregatedOutput = "Viewed image /tmp/image.png";
    const original = JSON.stringify(value);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: emptyComposerState(),
          thread: thread([turnWithItems("inProgress", [value])]),
          threadAttachments: {
            "view-call": [
              {
                type: "attachment",
                sha256: "f".repeat(64),
                mediaType: "image/png",
                byteLength: 68,
                width: 1,
                height: 1,
              },
            ],
          },
          onDraftChange: () => {},
          onInterrupt: noop,
          onRespondToApproval: noop,
          onSubmit: noop,
        }),
      ),
    );
    assert.equal(document.querySelector('[aria-label="Tool images"]'), null);
    await act(async () => requiredButton(".trace-item-toggle").click());
    assert.ok(document.querySelector('[aria-label="Tool images"]'));
    assert.ok(document.querySelector('[aria-label="Preview Tool image 1"]'));
    assert.equal(
      document.querySelector(".trace-input-preview")?.textContent,
      value.command,
    );
    assert.match(
      document.body.textContent ?? "",
      /Viewed image \/tmp\/image.png/,
    );
    assert.equal(JSON.stringify(value), original);
    await act(async () => requiredButton(".trace-item-toggle").click());
    assert.equal(
      requiredElement('.trace-reveal[data-open="false"]').getAttribute(
        "aria-hidden",
      ),
      "true",
    );
  });
});

test("tool input offers disclosure only while its two-line preview overflows", async () => {
  await withDom(async (root) => {
    await withInputPreviewLayout(async (resize) => {
      const value = commandItem(
        "short-input",
        'zenx_plugin {"operation":"read","pluginId":"computer"}',
      );
      await renderInteractive(root, turnWithItems("inProgress", [value]));
      await act(async () => requiredButton(".trace-item-toggle").click());
      assert.ok(!document.querySelector(".trace-input summary"));
      assert.ok(!document.querySelector(".trace-input-heading svg"));
      assert.equal(
        requiredElement(".trace-input-preview code").textContent,
        value.type === "commandExecution" ? value.command : "",
      );

      await act(async () => resize(60));
      const input = requiredElement<HTMLDetailsElement>("details.trace-input");
      assert.equal(input.open, false);
      await act(async () =>
        requiredElement<HTMLElement>(".trace-input summary").click(),
      );
      assert.equal(input.open, true);
      // Widening while expanded must remove the obsolete control too.
      await act(async () => resize(40));
      assert.ok(!document.querySelector(".trace-input summary"));
      assert.ok(!document.querySelector(".trace-input-heading svg"));
      await act(async () => resize(60));
      assert.equal(
        requiredElement<HTMLDetailsElement>("details.trace-input").open,
        false,
      );
    });
  });
});

async function withInputPreviewLayout(
  run: (resize: (height: number) => void) => Promise<void>,
  initialHeight = 40,
) {
  let contentHeight = initialHeight;
  const callbacks = new Set<() => void>();
  const previous = globalThis.ResizeObserver;
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("trace-input-preview") ? 40 : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("trace-input-preview")
          ? contentHeight
          : 0;
      },
    },
  });
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe() {
      callbacks.add(this.callback);
    }
    unobserve() {
      callbacks.delete(this.callback);
    }
    disconnect() {
      callbacks.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  try {
    await run((height) => {
      contentHeight = height;
      for (const callback of [...callbacks]) callback();
    });
  } finally {
    globalThis.ResizeObserver = previous;
  }
}

test("tool details disclose full input independently of scrollable output", async () => {
  await withDom(async (root) => {
    await withInputPreviewLayout(async () => {
      const value = commandItem(
        "long-tool",
        "printf 'first line\\nsecond line\\nlast line'".repeat(20),
      );
      if (value.type !== "commandExecution") return;
      value.aggregatedOutput = Array.from(
        { length: 80 },
        (_, index) => `Result ${index}`,
      ).join("\n");
      await renderInteractive(root, turnWithItems("inProgress", [value]));
      await act(async () => requiredButton(".trace-item-toggle").click());
      const input = requiredElement(".trace-input") as HTMLDetailsElement;
      const summary = requiredElement(".trace-input summary") as HTMLElement;
      assert.equal(input.open, false);
      assert.equal(
        requiredElement(".trace-input-preview code").textContent,
        value.command,
      );
      await act(async () => summary.click());
      assert.equal(input.open, true);
      assert.equal(
        requiredElement(".trace-command code").textContent,
        value.command,
      );
      const output = requiredElement(
        '[role="region"][aria-label="Tool output"]',
      );
      assert.equal(output.getAttribute("tabindex"), "0");
      assert.equal(
        output.querySelector("pre")?.textContent,
        value.aggregatedOutput,
      );
      await act(async () => summary.click());
      assert.equal(input.open, false);
      assert.equal(
        output.querySelector("pre")?.textContent,
        value.aggregatedOutput,
      );
    }, 80);
  });
});

test("running and completed durations share second, minute and hour formatting", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10_000 });
  await withDom(async (root) => {
    for (const [duration, label] of [
      [0, "0s"],
      [999, "0s"],
      [59_999, "59s"],
      [60_000, "1m 0s"],
      [61_000, "1m 1s"],
      [3_599_999, "59m 59s"],
      [3_600_000, "1h 0m 0s"],
      [3_723_000, "1h 2m 3s"],
      [90_061_000, "25h 1m 1s"],
    ] as const) {
      t.mock.timers.setTime(10_000 + duration);
      await renderInteractive(root, turnWithItems("inProgress", []));
      assert.equal(
        requiredElement(".turn-running-label").textContent,
        `Working for ${label}`,
      );
      await renderInteractive(root, turnWithItems("completed", [], duration));
      assert.equal(
        requiredElement(".turn-toggle").textContent,
        `Worked for ${label}`,
      );
    }
  });
});

test("running duration ticks from turn start and stops on completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 22_000 });
  await withDom(async (root) => {
    await renderInteractive(root, turnWithItems("inProgress", []));
    assert.equal(
      requiredElement(".turn-running-label").textContent,
      "Working for 12s",
    );
    await act(async () => t.mock.timers.tick(2_000));
    assert.equal(
      requiredElement(".turn-running-label").textContent,
      "Working for 14s",
    );
    await act(async () => t.mock.timers.tick(46_000));
    assert.equal(
      requiredElement(".turn-running-label").textContent,
      "Working for 1m 0s",
    );
    await act(async () => t.mock.timers.tick(3_540_000));
    assert.equal(
      requiredElement(".turn-running-label").textContent,
      "Working for 1h 0m 0s",
    );
    await renderInteractive(root, turnWithItems("completed", [], 3_600_000));
    assert.equal(document.querySelector(".turn-running-label"), null);
    await act(async () => t.mock.timers.tick(2_000));
    assert.equal(
      requiredElement(".turn-toggle").textContent,
      "Worked for 1h 0m 0s",
    );
  });
});

test("send hover options preserve actual shortcuts and changing defaults never sends", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    const sends: string[] = [];
    let mode: "soft" | "batch" | "queue" | "hard" = "soft";
    const renderControl = () =>
      root.render(
        createElement(ComposerSendControl, {
          mode,
          running: true,
          hasDraft: true,
          disabled: false,
          sendDisabled: false,
          primaryMode: "steer",
          primaryLabel: "Steer now",
          compact: false,
          onPrimary: () => sends.push("primary"),
          onSend: (intent) => sends.push(intent),
          onStop: () => sends.push("stop"),
          onModeChange: async (next) => {
            mode = next;
            renderControl();
          },
        }),
      );
    await act(async () => renderControl());
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () =>
      requiredElement(".composer-send-control").dispatchEvent(
        new window.MouseEvent("pointerover", { bubbles: true }),
      ),
    );
    const panel = requiredElement('[role="dialog"][aria-label="Send options"]');
    assert.equal(document.querySelector("form .composer-send-popover"), null);
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>("button")];
    assert.match(
      buttons.find((button) => button.textContent?.startsWith("Steer now"))!
        .textContent!,
      /Enter/,
    );
    assert.match(
      buttons.find((button) => button.textContent?.startsWith("Next turn"))!
        .textContent!,
      /(?:Ctrl\+|⌘)Enter/,
    );
    assert.equal(
      buttons
        .find((button) => button.textContent?.startsWith("Each turn"))!
        .querySelector("kbd"),
      null,
    );
    await act(async () =>
      requiredButton('[aria-label="Default send mode"]').click(),
    );
    await act(async () =>
      requiredElement('[role="option"][data-value="queue"]').click(),
    );
    assert.equal(mode, "queue");
    assert.deepEqual(sends, []);
    assert.equal(
      requiredButton('[aria-label="Default send mode"]').getAttribute(
        "data-value",
      ),
      "queue",
    );
    const nextButton = [
      ...panel.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) => button.querySelector("strong")?.textContent === "Next turn",
    )!;
    await act(async () => nextButton.click());
    assert.deepEqual(sends, ["batch-next"]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});

test("send preferences keep the current choice on a failed save and expose the error", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    await act(async () =>
      root.render(
        createElement(ComposerSendControl, {
          mode: "soft",
          running: false,
          hasDraft: false,
          disabled: true,
          sendDisabled: false,
          primaryMode: "send",
          primaryLabel: "Send",
          compact: false,
          onPrimary: () => assert.fail("must not send"),
          onSend: () => assert.fail("must not send"),
          onStop: () => assert.fail("must not stop"),
          onModeChange: async () => {
            throw new Error("Settings changed elsewhere");
          },
        }),
      ),
    );
    await act(async () =>
      requiredButton('[aria-label="Send options"]').click(),
    );
    await act(async () =>
      requiredButton('[aria-label="Default send mode"]').click(),
    );
    await act(async () =>
      requiredElement('[role="option"][data-value="hard"]').click(),
    );
    assert.equal(
      requiredButton('[aria-label="Default send mode"]').getAttribute(
        "data-value",
      ),
      "soft",
    );
    assert.equal(
      requiredElement('[role="alert"]').textContent,
      "Settings changed elsewhere",
    );
  });
});

test("completed thread actions show the action without a second success badge", async () => {
  await withDom(async (root) => {
    const item = commandItem("sent", "threads_send");
    if (item.type !== "commandExecution") throw new Error("missing command");
    await renderInteractive(
      root,
      turnWithItems("inProgress", [{ ...item, toolName: "zenx_threads_send" }]),
    );
    assert.match(
      requiredElement(".trace-item-toggle").textContent ?? "",
      /Sent message/,
    );
    assert.equal(document.querySelector(".trace-item .tool-status"), null);
    assert.doesNotMatch(
      requiredElement(".trace-item-toggle").textContent ?? "",
      /completed/i,
    );
  });
});

test("send panel Stop follows interrupt availability independently of send availability", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    for (const stopDisabled of [true, false]) {
      let stops = 0;
      await act(async () =>
        root.render(
          createElement(ComposerSendControl, {
            mode: "soft",
            running: true,
            hasDraft: true,
            disabled: true,
            sendDisabled: true,
            stopDisabled,
            primaryMode: "steer",
            primaryLabel: "Steer now",
            compact: false,
            onPrimary: () => assert.fail("must not send"),
            onSend: () => assert.fail("must not send"),
            onStop: () => stops++,
          }),
        ),
      );
      await act(async () =>
        requiredElement<HTMLDivElement>(".composer-send-control").dispatchEvent(
          new window.MouseEvent("pointerover", { bubbles: true }),
        ),
      );
      const stop = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".composer-send-options button",
        ),
      ].find(
        (button) => button.querySelector("strong")?.textContent === "Stop",
      )!;
      assert.equal(stop.disabled, stopDisabled);
      await act(async () => stop.click());
      assert.equal(stops, stopDisabled ? 0 : 1);
    }
  });
});

test("send options have an explicit click target while the primary still submits", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    const calls: string[] = [];
    await act(async () =>
      root.render(
        createElement(ComposerSendControl, {
          mode: "soft",
          running: true,
          hasDraft: true,
          disabled: false,
          sendDisabled: false,
          primaryMode: "steer",
          primaryLabel: "Steer now",
          compact: false,
          onPrimary: () => calls.push("primary"),
          onSend: (intent) => calls.push(intent),
          onStop: () => calls.push("stop"),
        }),
      ),
    );
    const primary = requiredButton(".action-orb");
    assert.equal(primary.getAttribute("aria-haspopup"), null);
    const disclosure = requiredButton('[aria-label="Send options"]');
    await act(async () => disclosure.click());
    assert.deepEqual(calls, []);
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.match(
      requiredElement(".composer-send-heading").textContent!,
      /Steer now/,
    );
    assert.match(
      requiredElement(".composer-send-description").textContent!,
      /current turn/,
    );
    await act(async () => primary.click());
    assert.deepEqual(calls, ["primary"]);
    assert.equal(document.querySelector(".composer-send-popover"), null);
  });
});

test("send disclosure supports keyboard focus and Escape without reopening", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    await act(async () =>
      root.render(
        createElement(ComposerSendControl, {
          mode: "soft",
          running: true,
          hasDraft: true,
          disabled: false,
          sendDisabled: false,
          primaryMode: "steer",
          primaryLabel: "Steer now",
          compact: false,
          onPrimary: () => assert.fail("must not submit"),
          onSend: () => assert.fail("must not submit"),
          onStop: () => assert.fail("must not stop"),
        }),
      ),
    );
    const disclosure = requiredButton('[aria-label="Send options"]');
    await act(async () => {
      disclosure.focus();
      disclosure.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    assert.equal(
      document.activeElement?.matches(
        ".composer-send-popover button:not(:disabled)",
      ),
      true,
    );
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await waitForSendFocus("Send options");
    assert.equal(document.querySelector(".composer-send-popover"), null);
  });
});

test("touch send never requires hover and options stay available when sending is disabled", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    let calls = 0;
    const renderControl = (disabled: boolean) =>
      root.render(
        createElement(ComposerSendControl, {
          mode: "soft",
          running: false,
          hasDraft: true,
          disabled,
          sendDisabled: disabled,
          primaryMode: "send",
          primaryLabel: "Send",
          compact: false,
          onPrimary: () => calls++,
          onSend: () => calls++,
          onStop: () => calls++,
        }),
      );
    await act(async () => renderControl(false));
    const touch = (type: string) => {
      const event = new window.MouseEvent(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      return event;
    };
    await act(async () => {
      requiredElement(".composer-send-control").dispatchEvent(
        touch("pointerover"),
      );
      requiredButton(".action-orb").dispatchEvent(touch("pointerdown"));
      requiredButton(".action-orb").focus();
    });
    assert.equal(document.querySelector(".composer-send-popover"), null);
    await act(async () => requiredButton(".action-orb").click());
    assert.equal(calls, 1);
    await act(async () => renderControl(true));
    await act(async () =>
      requiredButton('[aria-label="Send options"]').click(),
    );
    assert.equal(requiredButton(".composer-send-summary").disabled, true);
    assert.equal(requiredButton('[aria-label="Send options"]').disabled, false);
    assert.equal(calls, 1);
  });
});

test("an open send panel closes when the running turn ends without sending the draft", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    const renderControl = (running: boolean) =>
      root.render(
        createElement(ComposerSendControl, {
          mode: "soft",
          running,
          hasDraft: true,
          disabled: false,
          sendDisabled: false,
          primaryMode: running ? "steer" : "send",
          primaryLabel: running ? "Steer now" : "Send",
          compact: false,
          onPrimary: () => assert.fail("must not send"),
          onSend: () => assert.fail("must not send"),
          onStop: () => assert.fail("must not stop"),
        }),
      );
    await act(async () => renderControl(true));
    await act(async () =>
      requiredButton('[aria-label="Send options"]').click(),
    );
    assert.ok(document.querySelector(".composer-send-popover"));
    await act(async () => renderControl(false));
    assert.equal(document.querySelector(".composer-send-popover"), null);
    await waitForSendFocus("Send options");
    assert.equal(
      requiredButton(".action-orb").getAttribute("aria-label"),
      "Send",
    );
  });
});

test("panel action returns keyboard focus while hover Escape preserves the editor focus", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    const calls: string[] = [];
    await act(async () =>
      root.render(
        createElement(
          React.Fragment,
          {},
          createElement("textarea", { "aria-label": "Outside editor" }),
          createElement(ComposerSendControl, {
            mode: "soft",
            running: true,
            hasDraft: true,
            disabled: false,
            sendDisabled: false,
            primaryMode: "steer",
            primaryLabel: "Steer now",
            compact: false,
            onPrimary: () => calls.push("primary"),
            onSend: (intent) => calls.push(intent),
            onStop: () => calls.push("stop"),
          }),
        ),
      ),
    );
    await act(async () =>
      requiredButton('[aria-label="Send options"]').click(),
    );
    await act(async () =>
      requiredButton(".composer-send-options button").click(),
    );
    assert.deepEqual(calls, ["batch-next"]);
    await waitForSendFocus("Send options");
    const editor = requiredElement<HTMLTextAreaElement>(
      '[aria-label="Outside editor"]',
    );
    await act(async () => editor.focus());
    await act(async () =>
      requiredElement(".composer-send-control").dispatchEvent(
        new window.MouseEvent("pointerover", { bubbles: true }),
      ),
    );
    assert.ok(document.querySelector(".composer-send-popover"));
    await act(async () =>
      editor.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector(".composer-send-popover"), null);
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Outside editor",
    );
    assert.deepEqual(calls, ["batch-next"]);
  });
});

test("turn transition restores nested preference focus without stealing outside focus", async () => {
  await withDom(async (root) => {
    const { ComposerSendControl } =
      await import("../src/renderer/src/ComposerSendControl.js");
    const renderControl = (running: boolean) =>
      root.render(
        createElement(
          React.Fragment,
          {},
          createElement("input", { "aria-label": "Outside control" }),
          createElement(ComposerSendControl, {
            mode: "soft",
            running,
            hasDraft: true,
            disabled: false,
            sendDisabled: false,
            primaryMode: running ? "steer" : "send",
            primaryLabel: running ? "Steer now" : "Send",
            compact: false,
            onPrimary: () => assert.fail("must not send"),
            onSend: () => assert.fail("must not send"),
            onStop: () => assert.fail("must not stop"),
            onModeChange: async () => {},
          }),
        ),
      );
    await act(async () => renderControl(true));
    await act(async () =>
      requiredButton('[aria-label="Send options"]').click(),
    );
    await act(async () =>
      requiredButton('[aria-label="Default send mode"]').click(),
    );
    assert.equal(document.activeElement?.getAttribute("role"), "option");
    await act(async () => renderControl(false));
    assert.equal(document.querySelector(".composer-send-popover"), null);
    await waitForSendFocus("Send options");
    await act(async () =>
      requiredElement<HTMLInputElement>(
        '[aria-label="Outside control"]',
      ).focus(),
    );
    await act(async () => renderControl(true));
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Outside control",
    );
    assert.equal(document.querySelector(".composer-send-popover"), null);
  });
});

// Radix restores focus after its closing FocusScope has unmounted.
async function waitForSendFocus(label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (
    document.activeElement?.getAttribute("aria-label") !== label &&
    Date.now() < deadline
  ) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  assert.equal(document.activeElement?.getAttribute("aria-label"), label);
}

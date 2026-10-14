import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { ThreadDebugger } from "../src/renderer/src/ThreadDebugger.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  runtimeThread,
  runtimeMessage,
} from "./fixtures/agent-runtime-data.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
import type { CanonicalItem } from "../../../src/item.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const noop = async () => undefined;
async function dom(
  run: (root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const prev = { window: globalThis.window, document: globalThis.document };
  const d = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: d.window,
    document: d.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prev, { IS_REACT_ACT_ENVIRONMENT: false });
    d.window.close();
  }
}
function fixture(text = "hello") {
  const base = runtimeThread(
    [runtimeMessage("answer", text)],
    "interrupted",
    "thread",
  );
  return {
    ...base,
    cwd: "/project/actual-thread",
    canonicalItems: nativeRecoveryForThread(base).thread.items,
  };
}
const props = (thread: ReturnType<typeof fixture>) => ({
  thread,
  approvals: [],
  composer: emptyComposerState(),
  onDraftChange: noop,
  onInterrupt: noop,
  onRespondToApproval: noop,
  onSubmit: noop,
});
async function debug() {
  await act(async () =>
    document
      .querySelectorAll<HTMLButtonElement>(".thread-view-switch button")[1]!
      .click(),
  );
}

test("debugger keeps thread cwd for a relative Markdown image", async () =>
  dom(async (root) => {
    const reads: Array<[string, string | undefined]> = [];
    Object.assign(window, {
      zenx: {
        imageAttachments: {
          readLocal: (source: string, cwd?: string) => {
            reads.push([source, cwd]);
            return new Promise(() => {});
          },
        },
      },
    });
    await act(async () =>
      root.render(
        createElement(ThreadView, props(fixture("![image](./plot.png)"))),
      ),
    );
    assert.deepEqual(reads, [["./plot.png", "/project/actual-thread"]]);
    await debug();
    assert.deepEqual(reads, [
      ["./plot.png", "/project/actual-thread"],
      ["./plot.png", "/project/actual-thread"],
    ]);
  }));

test("debugger preserves main conversation message-link routing", async () =>
  dom(async (root) => {
    const opened: unknown[] = [];
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          ...props(fixture("[result](./result.txt)")),
          onOpenMessageLink: (target) => opened.push(target),
        }),
      ),
    );
    assert.ok(
      document.querySelector(".markdown-body a"),
      "conversation link exists",
    );
    await debug();
    const link = document.querySelector<HTMLAnchorElement>(".markdown-body a");
    assert.ok(link, "debugger should retain the same read-only link");
    await act(async () => link.click());
    assert.deepEqual(opened, [{ kind: "file", value: "./result.txt" }]);
  }));

test("closed metadata row does not materialize its entire large payload", async () =>
  dom(async (root) => {
    const thread = fixture();
    const value = "x".repeat(2 * 1024 * 1024);
    const item: CanonicalItem = {
      id: "large-state",
      threadId: thread.id,
      turnId: "turn",
      createdAt: "2026-10-14T00:00:00Z",
      type: "code_state",
      callId: "call",
      key: "large",
      value,
    };
    await act(async () =>
      root.render(createElement(ThreadDebugger, { thread, items: [item] })),
    );
    assert.equal(document.querySelectorAll("details[open]").length, 0);
    const length = document.querySelector(".thread-debug-metadata")!
      .textContent!.length;
    console.log(
      JSON.stringify({
        closedMetadataCharacters: length,
        exactJsonPreCount: document.querySelectorAll(".thread-debug-json pre")
          .length,
      }),
    );
    assert.ok(
      length < 65536,
      `closed default row materialized ${length} characters`,
    );
  }));

test("initial long-history view bounds mounted rows while preserving access to all Items", async () =>
  dom(async (root) => {
    const thread = fixture();
    const items: CanonicalItem[] = Array.from({ length: 3000 }, (_, i) => ({
      id: `lifecycle-${i}`,
      threadId: thread.id,
      createdAt: "2026-10-14T00:00:00Z",
      type: "thread_deleted",
    }));
    const started = performance.now();
    await act(async () =>
      root.render(createElement(ThreadDebugger, { thread, items })),
    );
    const rows = document.querySelectorAll("[data-item-id]").length;
    console.log(
      JSON.stringify({
        historySize: items.length,
        mountedRows: rows,
        domElements: document.querySelectorAll("*").length,
        renderMilliseconds: Math.round(performance.now() - started),
      }),
    );
    assert.ok(rows <= 500, `mounted all ${rows} rows at once`);
  }));

test("paging exposes every Item exactly once and large output remains explicitly expandable", async () =>
  dom(async (root) => {
    const thread = fixture();
    const items: CanonicalItem[] = Array.from({ length: 123 }, (_, i) => ({
      id: `row-${i}`,
      threadId: thread.id,
      createdAt: "2026-10-14T00:00:00Z",
      type: "thread_deleted",
    }));
    await act(async () =>
      root.render(createElement(ThreadDebugger, { thread, items })),
    );
    const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      seen.push(
        ...[...document.querySelectorAll("[data-item-id]")].map((e) =>
          e.getAttribute("data-item-id")!,
        ),
      );
      if (page < 2)
        await act(async () =>
          document
            .querySelectorAll<HTMLButtonElement>(
              ".thread-debug-paging button",
            )[1]!
            .click(),
        );
    }
    assert.deepEqual(
      seen,
      items.map((item) => item.id),
    );
    assert.ok(
      document.querySelectorAll<HTMLButtonElement>(
        ".thread-debug-paging button",
      )[1]!.disabled,
    );
    await act(async () =>
      root.render(
        createElement(ThreadDebugger, {
          key: "large",
          thread,
          items: [
            {
              id: "large-output",
              threadId: thread.id,
              turnId: "turn",
              createdAt: "2026-10-14T00:00:00Z",
              type: "tool_result",
              callId: "unknown",
              exitCode: 0,
              output: "x".repeat(100000),
            },
          ],
        }),
      ),
    );
    assert.equal(
      document.querySelector(".thread-debug-item pre")!.textContent!.length,
      8192,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-debug-more")!.click(),
    );
    assert.equal(
      document.querySelector(".thread-debug-item pre")!.textContent!.length,
      100000,
    );
  }));

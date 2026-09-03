import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { AttachmentRef } from "../../../src/attachment.js";
import type { Thread } from "../src/protocol-client/index.js";
import {
  addComposerImages,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";

const { act, createElement } = React;
Object.assign(globalThis, { React });
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");

const ref: AttachmentRef = {
  type: "attachment",
  sha256: "a".repeat(64),
  mediaType: "image/png",
  byteLength: 4,
  width: 1,
  height: 1,
};

test("paste and drop preserve file order while image-only send remains available", async () => {
  await withDom(async (dom, root) => {
    const imported: string[][] = [];
    let pickerCalls = 0;
    const submissions: string[] = [];
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "first.png", attachment: ref },
    ]);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onImportImages: async (files: readonly File[]) => {
            imported.push(files.map((file) => file.name));
          },
          onInterrupt: async () => undefined,
          onPickImages: async () => {
            pickerCalls += 1;
          },
          onReadAttachment: async () => new Uint8Array([1, 2, 3, 4]),
          onRemoveImage: () => undefined,
          onRespondToApproval: async () => undefined,
          onSubmit: async (intent: string) => {
            submissions.push(intent);
          },
        }),
      ),
    );
    const textarea = required<HTMLTextAreaElement>("textarea");
    await act(async () =>
      required<HTMLButtonElement>('[aria-label="Add images"]').click(),
    );
    assert.equal(pickerCalls, 1);
    const files = [
      new dom.window.File(["a"], "a.png", { type: "image/png" }),
      new dom.window.File(["b"], "b.webp", { type: "image/webp" }),
    ];
    const paste = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(paste, "clipboardData", { value: { files } });
    await act(async () => textarea.dispatchEvent(paste));

    const drop = new dom.window.Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files, dropEffect: "none" },
    });
    await act(async () => required(".thread-view").dispatchEvent(drop));
    assert.deepEqual(imported, [
      ["a.png", "b.webp"],
      ["a.png", "b.webp"],
    ]);

    await act(async () =>
      required<HTMLButtonElement>('[aria-label="Send"]').click(),
    );
    assert.deepEqual(submissions, ["start"]);
  });
});

test("image preview closes with Escape and returns focus to its named trigger", async () => {
  await withDom(async (_dom, root) => {
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "focus.png", attachment: ref },
    ]);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1, 2, 3, 4]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      ),
    );
    await act(async () => Promise.resolve());
    const trigger = required<HTMLButtonElement>(
      '[aria-label="Preview focus.png"]',
    );
    assert.equal(trigger.disabled, false);
    await act(async () => trigger.click());
    assert.equal(
      required('[role="dialog"]').getAttribute("aria-modal"),
      "true",
    );
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Close image preview",
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Tab",
        }),
      ),
    );
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Close image preview",
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
  });
});

test("unsupported image capability disables Send without removing the draft", async () => {
  await withDom(async (_dom, root) => {
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "blocked.png", attachment: ref },
    ]);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          imageCapabilityError: "This model does not support image input.",
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => assert.fail("blocked before submission"),
        }),
      ),
    );
    assert.equal(
      required<HTMLButtonElement>('[aria-label="Send"]').disabled,
      true,
    );
    assert.match(
      document.body.textContent ?? "",
      /does not support image input/u,
    );
    assert.ok(required('[aria-label="Preview blocked.png"]'));
  });
});

test("Unknown image capability warns but keeps the try-send action available", async () => {
  await withDom(async (_dom, root) => {
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "unknown.png", attachment: ref },
    ]);
    let submitted = false;
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          imageCapabilityNotice:
            "Image input capability is unknown. You can try sending now.",
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => void (submitted = true),
        }),
      ),
    );
    const send = required<HTMLButtonElement>('[aria-label="Send"]');
    assert.equal(send.disabled, false);
    assert.match(document.body.textContent ?? "", /try sending now/u);
    await act(async () => send.click());
    assert.equal(submitted, true);
  });
});

test("the Composer overlay publishes its live bottom-zone height", async () => {
  await withDom(async (_dom, root) => {
    let notify: (() => void) | null = null;
    class FakeResizeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(): void {}
      disconnect(): void {}
    }
    Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });
    try {
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: emptyComposerState(),
            thread: emptyThread(),
            onDraftChange: () => undefined,
            onInterrupt: async () => undefined,
            onRespondToApproval: async () => undefined,
            onSubmit: async () => undefined,
          }),
        ),
      );
      const view = required<HTMLElement>(".thread-view");
      assert.equal(view.style.getPropertyValue("--bottom-zone-height"), "0px");
      required<HTMLElement>(".bottom-zone").getBoundingClientRect = () =>
        ({ height: 216 }) as DOMRect;
      assert.ok(notify !== null);
      await act(async () => notify?.());
      assert.equal(
        view.style.getPropertyValue("--bottom-zone-height"),
        "216px",
      );
    } finally {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });
});

test("attachment thumbnails reuse cached payloads across streaming re-renders and remounts", async () => {
  await withDom(async (dom, root) => {
    const streaming: AttachmentRef = {
      type: "attachment",
      sha256: "f".repeat(64),
      mediaType: "image/png",
      byteLength: 4,
      width: 1,
      height: 1,
    };
    let reads = 0;
    let createdUrls = 0;
    Object.assign(dom.window.URL, {
      createObjectURL: () => `blob:zenx-stream-${String((createdUrls += 1))}`,
    });
    const streamingView = (attachment: AttachmentRef) =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: addComposerImages(emptyComposerState(), [
            { id: "draft-1", name: "stream.png", attachment },
          ]),
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => {
            reads += 1;
            return new Uint8Array([1, 2, 3, 4]);
          },
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      );
    await act(async () => void streamingView(streaming));
    await act(async () => Promise.resolve());
    const firstSrc = required<HTMLImageElement>(".draft-image img").src;
    assert.equal(reads, 1);
    assert.equal(createdUrls, 1);

    // A streaming re-render with fresh callback and attachment identities of
    // the same attachment must not re-read, recreate the object URL, or drop
    // back to the loading placeholder.
    await act(async () => void streamingView({ ...streaming }));
    await act(async () => Promise.resolve());
    assert.equal(reads, 1);
    assert.equal(createdUrls, 1);
    assert.equal(required<HTMLImageElement>(".draft-image img").src, firstSrc);

    // Unmount and remount (Turn disclosure collapse and reopen) also reuse
    // the session cache instead of flashing the loading placeholder.
    await act(async () => root.render(null));
    await act(async () => void streamingView(streaming));
    assert.equal(reads, 1);
    assert.equal(createdUrls, 1);
    assert.equal(required<HTMLImageElement>(".draft-image img").src, firstSrc);
  });
});

async function withDom(
  run: (dom: JSDOM, root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    {
      url: "http://localhost",
    },
  );
  const previous = {
    Blob: globalThis.Blob,
    document: globalThis.document,
    File: globalThis.File,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    URL: globalThis.URL,
    window: globalThis.window,
  };
  Object.assign(dom.window.URL, {
    createObjectURL: () => "blob:zenx-image",
    revokeObjectURL: () => undefined,
  });
  Object.assign(globalThis, {
    Blob: dom.window.Blob,
    document: dom.window.document,
    File: dom.window.File,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    URL: dom.window.URL,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await run(dom, root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

function required<T extends Element = Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  assert.ok(value, `Missing ${selector}`);
  return value;
}

function emptyThread(): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "provider",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

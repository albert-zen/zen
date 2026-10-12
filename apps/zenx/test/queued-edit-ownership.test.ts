import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { QueuedMessageEditor } from "../src/renderer/src/QueuedMessageEditor.js";
import { createQueueEditStore } from "../src/renderer/src/queue-edit-state.js";
import { queuedDraftInput } from "../src/renderer/src/queue-edit-draft.js";
import { draft, type ViewProps } from "./agent-runtime-dom.js";
import { editQueueFact, queueScenario } from "./fixtures/agent-queue-data.js";
import type { Thread } from "../src/protocol-client/index.js";

async function withDom(
  run: (render: (node: ReactNode) => Promise<void>) => Promise<void>,
) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(async (node) => {
      await act(async () => root.render(node));
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}
const editor = () =>
  document.querySelector<HTMLElement>(".queued-message-editor");
const textarea = () =>
  editor()!.querySelector<HTMLTextAreaElement>("textarea")!;
async function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(element, selector);
  await act(async () => element.click());
  return element;
}
async function changeText(value: string) {
  const input = textarea();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function view(name: string, thread: Thread, props: Partial<ViewProps>) {
  return React.createElement(
    "div",
    { key: name, "data-view": name },
    React.createElement(ThreadView, {
      thread,
      approvals: [],
      composer: draft,
      composerId: `composer-${name}`,
      onDraftChange() {},
      onInterrupt: async () => {},
      onRespondToApproval: async () => {},
      onSubmit: async () => {},
      ...props,
    }),
  );
}

test("shared queue editor owner cannot be stolen or cleared by a hidden same-thread viewport", async () => {
  await withDom(async (render) => {
    const store = createQueueEditStore();
    let thread = queueScenario(0);
    const props: Partial<ViewProps> = {
      queueEditStore: store,
      onEditQueued: async () => {
        throw new Error("unused");
      },
    };
    const views = () =>
      React.createElement(
        React.Fragment,
        null,
        view("main", thread, props),
        view("side", thread, props),
      );
    await render(views());
    await click('[data-view="main"] [data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Owned draft survives the other viewport");
    const [key, session] = Object.entries(store.getSnapshot())[0]!;
    assert.ok(session.owner);
    await click('[data-view="side"] [data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(document.querySelectorAll(".queued-message-editor").length, 1);
    assert.equal(store.getSnapshot()[key]!.owner, session.owner);
    assert.equal(textarea().value, session.draft.text);

    const request = {
      threadId: thread.id,
      queuedItemId: session.queuedItemId,
      clientId: session.clientId,
      expectedRevision: session.expectedRevision,
      editId: "owned-edit",
      input: queuedDraftInput(session.draft),
    };
    thread = editQueueFact(thread, request);
    const item = thread.canonicalItems!.find(
      (entry) => entry.type === "user_message_queue_edited",
    )!;
    await act(async () =>
      store.set(key, {
        ...session,
        attempt: {
          editId: request.editId,
          fingerprint: JSON.stringify(request.input),
        },
        confirmed: {
          editItemId: item.id,
          revision: session.expectedRevision + 1,
        },
      }),
    );
    await render(views());
    assert.ok(
      store.getSnapshot()[key],
      "the hidden sibling cannot retire an owned editor",
    );
    assert.ok(editor());
    assert.equal(textarea().value, session.draft.text);
    await click(".queue-editor-close");
    assert.equal(editor(), null);
    assert.equal(store.getSnapshot()[key], undefined);
  });
});

test("a surviving viewport takes over the latest draft after the old owner unmounts", async () => {
  await withDom(async (render) => {
    const store = createQueueEditStore();
    const thread = queueScenario(0);
    const props: Partial<ViewProps> = {
      queueEditStore: store,
      onEditQueued: async () => {
        throw new Error("unused");
      },
    };
    await render(
      React.createElement(
        React.Fragment,
        null,
        view("main", thread, props),
        view("side", thread, props),
      ),
    );
    await click('[data-view="main"] [data-queue-id="queue-0"] .queue-row-edit');
    await changeText("The latest locally edited queue draft");
    const [key] = Object.keys(store.getSnapshot());
    await render(
      React.createElement(React.Fragment, null, view("side", thread, props)),
    );
    assert.equal(store.getSnapshot()[key!]!.owner, undefined);
    assert.equal(editor(), null);
    await click('[data-view="side"] [data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(textarea().value, "The latest locally edited queue draft");
    assert.ok(store.getSnapshot()[key!]!.owner);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#composer-side")!.value,
      draft.draft.text,
    );
  });
});

test("editor reconciles the cache only when reopening and never overwrites active typing on parent rerenders", async () => {
  await withDom(async (render) => {
    let open = true;
    let initialDraft = { text: "Original cached draft", images: [] };
    const tree = () =>
      React.createElement(QueuedMessageEditor, {
        identity: "stable-identity",
        open,
        initialDraft,
        trigger: null,
        onClose() {},
        onSave: async () => {},
        onReadAttachment: async () => new Uint8Array(),
        onImportImages: async () => [],
        onPickImages: async () => [],
      });
    await render(tree());
    await changeText("Typing in progress");
    initialDraft = { text: "Unrelated stale parent snapshot", images: [] };
    await render(tree());
    assert.equal(textarea().value, "Typing in progress");
    open = false;
    await render(tree());
    initialDraft = {
      text: "Newer shared draft from another viewport",
      images: [],
    };
    open = true;
    await render(tree());
    assert.equal(textarea().value, initialDraft.text);
  });
});

test("detached or hidden editor controls cannot start another image picker", async () => {
  await withDom(async (render) => {
    let open = true;
    let picks = 0;
    const tree = () =>
      React.createElement(QueuedMessageEditor, {
        identity: "guarded-editor",
        open,
        initialDraft: { text: "Keep this", images: [] },
        trigger: null,
        onClose() {},
        onSave: async () => {},
        onReadAttachment: async () => new Uint8Array(),
        onImportImages: async () => [],
        onPickImages: async () => {
          picks++;
          return [];
        },
      });
    await render(tree());
    const add = editor()!.querySelector<HTMLButtonElement>(
      ".queue-editor-image-tools > button",
    )!;
    open = false;
    await render(tree());
    await act(async () => add.click());
    assert.equal(picks, 0);
    open = true;
    await render(tree());
    await click(".queue-editor-image-tools > button");
    assert.equal(picks, 1);
    const detached = editor()!.querySelector<HTMLButtonElement>(
      ".queue-editor-image-tools > button",
    )!;
    await render(null);
    await act(async () => detached.click());
    assert.equal(picks, 1);
  });
});

import {
  parseReferenceDraft,
  parseSentReferenceContent,
  referenceMessage,
  withReferenceDraft,
} from "../src/renderer/src/reference-draft.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  NativeQueueEditParams,
  NativeQueueEditResult,
} from "../../../src/protocol/native/wire.js";
import {
  queuedDraftInput,
  queuedInputDraft,
} from "../src/renderer/src/queue-edit-draft.js";
import { act, draft, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  drainQueueHead,
  editQueueFact,
  queueScenario,
} from "./fixtures/agent-queue-data.js";
import { queueImageAttachments } from "./fixtures/agent-queue-images.js";
import { pendingQueuedMessages } from "../../../src/input-queue.js";
import { projectQueuedImages } from "../src/renderer/src/queued-message-images.js";

const editor = () =>
  document.querySelector<HTMLDivElement>(".queued-message-editor");
const text = () => editor()!.querySelector<HTMLTextAreaElement>("textarea")!;
const mainDraft = () =>
  document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value;
const flush = async () => {
  await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const imageBytes = await readFile(
  new URL("./fixtures/assets/queue-images/queue-image-1.png", import.meta.url),
);
const readImage = async () => new Uint8Array(imageBytes);
const result = (p: NativeQueueEditParams): NativeQueueEditResult => ({
  status: "edited",
  queuedItemId: p.queuedItemId,
  clientId: p.clientId,
  revision: p.expectedRevision + 1,
  editItemId: `edit-${p.editId}`,
});
async function changeText(value: string) {
  const target = text();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(target, value);
    target.dispatchEvent(new window.Event("input", { bubbles: true }));
    target.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

test("queue edit draft round-trips ordinary text and ordered images without silently changing unsupported input", () => {
  const input = pendingQueuedMessages(queueScenario(2).canonicalItems!)[0]!
    .input;
  const value = queuedInputDraft(input, "queue-0")!;
  assert.deepEqual(queuedDraftInput(value), input);
  assert.deepEqual(
    value.images.map((x) => x.attachment),
    queueImageAttachments.slice(0, 2),
  );
  assert.equal(
    queuedInputDraft(
      [
        { type: "image", attachment: queueImageAttachments[0]! },
        { type: "text", text: "interleaved" },
      ],
      "q",
    ),
    null,
  );
  assert.equal(
    queuedInputDraft(
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      "q",
    ),
    null,
  );
});

test("cancel editing changes neither canonical queued input nor independent main Composer draft", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(2);
    let saves = 0,
      mainChanges = 0;
    await h.render(thread, {
      onReadAttachment: readImage,
      onEditQueued: async (p) => {
        saves++;
        return result(p);
      },
      onDraftChange: () => {
        mainChanges++;
      },
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Edited queue-only draft");
    assert.equal(text().value, "Edited queue-only draft");
    await h.click(".queue-editor-close");
    await flush();
    assert.equal(editor(), null);
    assert.equal(mainDraft(), draft.draft.text);
    assert.equal(mainChanges, 0);
    assert.equal(saves, 0);
    assert.deepEqual(
      thread.queuedMessages!.map((x) => x.id),
      ["queue-0", "queue-1"],
    );
  });
});

test("text and image edits save exact native target and revision without requeue or optimistic row mutation", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(2);
    let request!: NativeQueueEditParams;
    const props = {
      onReadAttachment: readImage,
      onEditQueued: async (p: NativeQueueEditParams) => {
        request = p;
        return result(p);
      },
      onPickQueueImages: async () => [
        {
          id: "new-image",
          name: "generated.png",
          attachment: queueImageAttachments[5]!,
        },
      ],
    };
    await h.render(thread, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Keep position, replace image selection.");
    await h.click(".queue-editor-images .remove-draft-image");
    await h.click(".queue-editor-image-tools > button");
    await h.click(".queue-editor-save");
    await flush();
    assert.equal(request.threadId, thread.id);
    assert.equal(request.queuedItemId, "queue-0");
    assert.equal(request.clientId, "queue-client-0");
    assert.equal(request.expectedRevision, 0);
    assert.ok(request.editId);
    assert.deepEqual(request.input, [
      { type: "text", text: "Keep position, replace image selection." },
      { type: "image", attachment: queueImageAttachments[1] },
      { type: "image", attachment: queueImageAttachments[5] },
    ]);
    assert.equal(editor(), null);
    assert.notEqual(
      thread.queuedMessages![0]!.text,
      "Keep position, replace image selection.",
    );
    thread = editQueueFact(thread, request);
    await h.render(thread, props);
    assert.deepEqual(
      thread.queuedMessages!.map((x) => x.id),
      ["queue-0", "queue-1"],
    );
    assert.equal(
      thread.queuedMessages![0]!.text,
      "Keep position, replace image selection.",
    );
    assert.deepEqual(projectQueuedImages(thread)["queue-0"], [
      queueImageAttachments[1],
      queueImageAttachments[5],
    ]);
    assert.equal(
      thread.canonicalItems!.filter((x) => x.type === "user_message_queued")
        .length,
      2,
    );
    assert.equal(
      thread.canonicalItems!.filter(
        (x) => x.type === "user_message_queue_cancelled",
      ).length,
      0,
    );
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("same-tick Save submits once and exact-content retry retains edit identity after transport rejection", async () => {
  await withRuntimeDom(async (h) => {
    const requests: NativeQueueEditParams[] = [];
    let reject!: (e: Error) => void;
    await h.render(queueScenario(2), {
      onReadAttachment: readImage,
      onEditQueued: (p) => {
        requests.push(p);
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      },
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Retry without dropping my changes");
    const save =
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!;
    await act(async () => {
      save.click();
      save.click();
    });
    assert.equal(requests.length, 1);
    assert.equal(save.disabled, true);
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    await act(async () => reject(new Error("Transport rejected")));
    assert.match(editor()!.textContent!, /Transport rejected/u);
    assert.equal(text().value, "Retry without dropping my changes");
    await h.click(".queue-editor-save");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.editId, requests[0]!.editId);
    assert.deepEqual(requests[1]!.input, requests[0]!.input);
    await act(async () => reject(new Error("Still unavailable")));
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("canonical start while editing preserves editor draft and cannot silently replace the started input", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(2);
    const props = {
      onReadAttachment: readImage,
      onEditQueued: async (p: NativeQueueEditParams) => {
        thread = editQueueFact(thread, p);
        return result(p);
      },
    };
    await h.render(thread, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Not yet saved when input started");
    thread = drainQueueHead(thread);
    await h.render(thread, props);
    await h.click(".queue-editor-save");
    assert.ok(editor());
    assert.equal(text().value, "Not yet saved when input started");
    assert.match(editor()!.textContent!, /已开始|cancelled|started/iu);
    assert.equal(thread.queuedMessages!.length, 1);
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("native revision conflict retains local edits and never retries against a newer revision automatically", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(2);
    let request!: NativeQueueEditParams;
    const props = {
      onReadAttachment: readImage,
      onEditQueued: async (p: NativeQueueEditParams) => {
        request = p;
        thread = editQueueFact(thread, p);
        return result(p);
      },
    };
    await h.render(thread, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("My unsaved local queue text");
    thread = editQueueFact(thread, {
      threadId: thread.id,
      queuedItemId: "queue-0",
      clientId: "queue-client-0",
      expectedRevision: 0,
      editId: "other-editor",
      input: [{ type: "text", text: "New authoritative text" }],
    });
    await h.render(thread, props);
    await h.click(".queue-editor-save");
    assert.equal(request.expectedRevision, 0);
    assert.equal(text().value, "My unsaved local queue text");
    assert.match(editor()!.textContent!, /已被修改|changed|conflict/iu);
    assert.equal(thread.queuedMessages![0]!.text, "New authoritative text");
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("Escape from nested image preview closes only the image and retains the queue editor", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(2), {
      onReadAttachment: readImage,
      onEditQueued: async (p) => result(p),
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await flush();
    const trigger = await h.click(".queue-editor-images .image-thumbnail");
    assert.ok(editor()!.querySelector(".image-preview-layer"));
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.ok(editor());
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("editor dropped images are imported once without bubbling into main Composer", async () => {
  await withRuntimeDom(async (h) => {
    let editorImports = 0,
      composerImports = 0;
    await h.render(queueScenario(2), {
      onReadAttachment: readImage,
      onEditQueued: async (p) => result(p),
      onImportImages: async () => {
        composerImports++;
      },
      onImportQueueImages: async (files) => {
        editorImports++;
        assert.equal(files[0]!.name, "new-generated.png");
        return [
          {
            id: "dropped",
            name: files[0]!.name,
            attachment: queueImageAttachments[4]!,
          },
        ];
      },
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    const drop = new window.MouseEvent("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [
          new window.File(["test"], "new-generated.png", { type: "image/png" }),
        ],
        dropEffect: "none",
      },
    });
    await act(async () =>
      editor()!.querySelector(".queue-editor-form")!.dispatchEvent(drop),
    );
    assert.equal(editorImports, 1);
    assert.equal(composerImports, 0);
    assert.equal(editor()!.querySelectorAll(".draft-image").length, 3);
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("a late save result from thread A cannot close or focus thread B editor", async () => {
  await withRuntimeDom(async (h) => {
    const a = queueScenario(2);
    const b = {
      ...a,
      id: "thread-b",
      canonicalItems: a.canonicalItems!.map((item) => ({
        ...item,
        threadId: "thread-b",
      })),
    };
    let saved!: NativeQueueEditParams;
    let resolve!: (r: NativeQueueEditResult) => void;
    const props = {
      onReadAttachment: readImage,
      onEditQueued: (p: NativeQueueEditParams) => {
        saved = p;
        return new Promise<NativeQueueEditResult>((done) => {
          resolve = done;
        });
      },
    };
    await h.render(a, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Thread A edited draft");
    await h.click(".queue-editor-save");
    await h.render(b, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Thread B independent editor");
    const bText = text();
    await act(async () => bText.focus());
    await act(async () => resolve(result(saved)));
    await flush();
    assert.equal(text().value, "Thread B independent editor");
    assert.equal(document.activeElement, bText);
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("successful edit receipt before event retains saved draft and prevents duplicate edit until exact canonical revision", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(2);
    let saved!: NativeQueueEditParams;
    const props = {
      onReadAttachment: readImage,
      onEditQueued: async (p: NativeQueueEditParams) => {
        saved = p;
        return result(p);
      },
    };
    await h.render(thread, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Saved text waiting for canonical event");
    await h.click(".queue-editor-save");
    await flush();
    assert.equal(thread.queuedMessages![0]!.text.startsWith("请保留"), true);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(text().value, "Saved text waiting for canonical event");
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!.disabled,
      true,
    );
    thread = editQueueFact(thread, saved);
    await h.render(thread, props);
    await flush();
    if (editor()) await h.click(".queue-editor-close");
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(text().value, "Saved text waiting for canonical event");
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!.disabled,
      false,
    );
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("editor image import blocks Save until finished and adds only to the editor draft", async () => {
  await withRuntimeDom(async (h) => {
    let saves = 0;
    let resolve!: (
      images: {
        id: string;
        name: string;
        attachment: (typeof queueImageAttachments)[0];
      }[],
    ) => void;
    await h.render(queueScenario(2), {
      onReadAttachment: readImage,
      onEditQueued: async (p) => {
        saves++;
        return result(p);
      },
      onPickQueueImages: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    const pick = document.querySelector<HTMLButtonElement>(
      ".queue-editor-image-tools > button",
    )!;
    const save =
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!;
    await act(async () => {
      pick.click();
      save.click();
    });
    assert.equal(saves, 0);
    assert.equal(save.disabled, true);
    await act(async () =>
      resolve([
        {
          id: "imported",
          name: "generated.png",
          attachment: queueImageAttachments[0]!,
        },
      ]),
    );
    assert.equal(editor()!.querySelectorAll(".draft-image").length, 3);
    assert.equal(save.disabled, false);
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("closing an editor after its queue trigger drains restores same-thread Composer without changing draft", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(1);
    const props = {
      onReadAttachment: readImage,
      onEditQueued: async (p: NativeQueueEditParams) => result(p),
    };
    await h.render(thread, props);
    const trigger = await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("Do not overwrite the main draft");
    thread = drainQueueHead(thread);
    await h.render(thread, props);
    assert.equal(trigger.isConnected, false);
    assert.equal(text().value, "Do not overwrite the main draft");
    await h.click(".queue-editor-close");
    await flush();
    assert.equal(editor(), null);
    assert.equal(
      document.activeElement,
      document.querySelector("#thread-composer"),
    );
    assert.equal(mainDraft(), draft.draft.text);
  });
});

test("editor closing after native drain does not steal an intentional outside selection", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(1);
    const props = {
      onReadAttachment: readImage,
      onEditQueued: async (p: NativeQueueEditParams) => result(p),
    };
    await h.render(thread, props);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    thread = drainQueueHead(thread);
    await h.render(thread, props);
    const outside = document.createElement("p");
    outside.textContent = "Reading another result";
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await h.click(".queue-editor-close");
    await flush();
    assert.equal(document.getSelection()!.toString(), "Reading another result");
    assert.notEqual(
      document.activeElement,
      document.querySelector("#thread-composer"),
    );
    assert.equal(mainDraft(), draft.draft.text);
    outside.remove();
  });
});

test("image-only queued input edits image order without inventing text or replacing the main draft", async () => {
  await withRuntimeDom(async (h) => {
    let captured!: NativeQueueEditParams;
    const thread = queueScenario(2);
    await h.render(thread, {
      onReadAttachment: readImage,
      onEditQueued: async (p) => {
        captured = p;
        return result(p);
      },
      onPickQueueImages: async () => [
        {
          id: "local-six",
          name: "Generated 6.png",
          attachment: queueImageAttachments[5]!,
        },
      ],
    });
    await h.click('[data-queue-id="queue-1"] .queue-row-edit');
    assert.equal(text().value, "");
    await h.click(".queue-editor-image-tools > button");
    await flush();
    await h.click(".queue-editor-save");
    await flush();
    assert.equal(captured.queuedItemId, "queue-1");
    assert.deepEqual(captured.input, [
      { type: "image", attachment: queueImageAttachments[2]! },
      { type: "image", attachment: queueImageAttachments[5]! },
    ]);
    assert.equal(mainDraft(), draft.draft.text);
    assert.deepEqual(
      thread.queuedMessages!.map((x) => x.id),
      ["queue-0", "queue-1"],
    );
  });
});

const queueReferences: import("../src/renderer/src/composer-selector.js").Reference[] =
  [
    {
      kind: "thread",
      name: "引用体系设计",
      cwd: "/synthetic",
      id: "source-thread",
    },
    {
      kind: "message",
      name: "ZenX",
      cwd: "/synthetic",
      threadId: "source-thread",
      id: "source-message",
      excerpt: "第一行\n  second <line>",
    },
    {
      kind: "file",
      name: "reference-plan.md",
      cwd: "/synthetic",
      path: "reference-plan.md",
    },
  ];
function referencedQueue(raw: string) {
  const thread = queueScenario(2);
  return {
    ...thread,
    canonicalItems: thread.canonicalItems!.map((item) =>
      item.type === "user_message_queued" && item.id === "queue-0"
        ? {
            ...item,
            input: [
              { type: "text" as const, text: raw },
              ...item.input.filter((part) => part.type !== "text"),
            ],
          }
        : item,
    ),
    queuedMessages: thread.queuedMessages!.map((item) =>
      item.id === "queue-0" ? { ...item, text: raw } : item,
    ),
  };
}

test("queue reference codec preserves order, exact excerpts, client binding, ordinary headers and repeated saves", () => {
  const raw = referenceMessage("问题", queueReferences, "queue-client-0");
  const input = [
    { type: "text" as const, text: raw },
    { type: "image" as const, attachment: queueImageAttachments[0]! },
  ];
  const draft = queuedInputDraft(input, "queue-0", "queue-client-0")!;
  assert.deepEqual(parseReferenceDraft(draft.text), {
    text: "问题",
    references: queueReferences,
  });
  assert.deepEqual(queuedDraftInput(draft, "queue-client-0"), input);
  assert.deepEqual(
    queuedDraftInput(
      queuedInputDraft(
        queuedDraftInput(draft, "queue-client-0"),
        "queue-0",
        "queue-client-0",
      )!,
      "queue-client-0",
    ),
    input,
  );
  const header = withReferenceDraft("literal", queueReferences);
  for (const literal of [
    header,
    `\\${header}`,
    `\\\\${header}`,
    raw,
    "[zenx-reference-message:v2]\n{malformed}",
  ]) {
    const ordinary = [{ type: "text" as const, text: literal }];
    const hydrated = queuedInputDraft(ordinary, "q", "different-client")!;
    assert.deepEqual(parseReferenceDraft(hydrated.text), {
      text: literal,
      references: [],
    });
    assert.deepEqual(queuedDraftInput(hydrated, "different-client"), ordinary);
  }
});

test("queue editor shows unified external references, edits/removes without double wrapping, and retains exact retry identity", async () => {
  await withRuntimeDom(async (h) => {
    const raw = referenceMessage("原问题", queueReferences, "queue-client-0");
    const requests: NativeQueueEditParams[] = [];
    let reject!: (reason: Error) => void;
    await h.render(referencedQueue(raw), {
      onReadAttachment: readImage,
      onEditQueued: (p) => {
        requests.push(p);
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      },
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(text().value, "原问题");
    assert.equal(editor()!.querySelectorAll(".reference-token").length, 3);
    assert.equal(editor()!.querySelector(".composer .reference-token"), null);
    assert.equal(
      editor()!.querySelector(".composer .queue-editor-images"),
      null,
    );
    await changeText("修改后的问题");
    await h.click(
      '.queue-editor-reference-rail [data-reference-kind="file"] .reference-token-remove',
    );
    assert.equal(editor()!.querySelectorAll(".reference-token").length, 2);
    await h.click(".queue-editor-save");
    const sent = requests[0]!;
    assert.equal(sent.clientId, "queue-client-0");
    assert.equal(sent.queuedItemId, "queue-0");
    assert.equal(sent.expectedRevision, 0);
    assert.equal(sent.input[0]!.type, "text");
    const payload = (sent.input[0] as { text: string }).text;
    assert.deepEqual(parseSentReferenceContent(payload, sent.clientId), {
      text: "修改后的问题",
      references: queueReferences.slice(0, 2),
    });
    assert.equal(payload.split("[zenx-reference-message:v2]").length, 2);
    assert.equal(
      editor()!.querySelector<HTMLButtonElement>(".reference-token-remove")!
        .disabled,
      true,
    );
    await act(async () => reject(new Error("Synthetic transport failure")));
    assert.equal(text().value, "修改后的问题");
    assert.equal(editor()!.querySelectorAll(".reference-token").length, 2);
    await h.click(".queue-editor-save");
    assert.equal(requests[1]!.editId, sent.editId);
    assert.deepEqual(requests[1]!.input, sent.input);
    await act(async () => reject(new Error("Synthetic retry failure")));
  });
});

test("queue editor hydrates and edits literal reserved headers as visible text, not references", async () => {
  await withRuntimeDom(async (h) => {
    const literal = `\\${withReferenceDraft("literal", queueReferences)}`;
    let request!: NativeQueueEditParams;
    await h.render(referencedQueue(literal), {
      onReadAttachment: readImage,
      onEditQueued: async (p) => {
        request = p;
        return result(p);
      },
    });
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(text().value, literal);
    assert.equal(editor()!.querySelectorAll(".reference-token").length, 0);
    const pasted = withReferenceDraft("pasted unchanged", queueReferences);
    await changeText(pasted);
    assert.equal(text().value, pasted);
    assert.equal(editor()!.querySelectorAll(".reference-token").length, 0);
    await h.click(".queue-editor-save");
    assert.equal((request.input[0] as { text: string }).text, pasted);
  });
});

test("queue excerpt source opens the exact visible message and suspends unsaved edits for reopening", async () => {
  await withRuntimeDom(async (h) => {
    const source = {
      ...queueReferences[1]!,
      kind: "message" as const,
      threadId: "runtime-thread",
      id: "queue-intro",
      excerpt: "同名消息，按 ID 定位",
    };
    const references = [source, queueReferences[2]!];
    const thread = referencedQueue(
      referenceMessage("原问题", references, "queue-client-0"),
    );
    thread.canonicalItems!.push({
      type: "agent_message",
      id: "queue-intro",
      threadId: thread.id,
      turnId: "runtime-turn",
      createdAt: "2026-10-21T00:00:00Z",
      text: "我会并行读取组件、检查页面，并运行验证。",
    });
    let saves = 0;
    await h.render(thread, {
      onReadAttachment: readImage,
      onEditQueued: async (p) => {
        saves++;
        return result(p);
      },
    });
    const target = document.querySelector<HTMLElement>(
      '[data-quote-thread-id="runtime-thread"][data-quote-item-id="queue-intro"]',
    )!;
    assert.ok(target);
    let scrolled = 0;
    target.scrollIntoView = () => {
      scrolled++;
    };
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    const identity = editor()!.dataset.queueEditorIdentity;
    await changeText("未保存的问题");
    await h.click(
      '.queue-editor-reference-rail [data-reference-kind="file"] .reference-token-remove',
    );
    await h.click(
      '.queue-editor-reference-rail [data-reference-kind="message"] .reference-token-details',
    );
    await h.click(".reference-open-source");
    await flush();
    assert.equal(editor(), null);
    assert.equal(scrolled, 1);
    assert.equal(document.activeElement, target);
    assert.equal(saves, 0);
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    assert.equal(editor()!.dataset.queueEditorIdentity, identity);
    assert.equal(text().value, "未保存的问题");
    assert.equal(editor()!.querySelectorAll(".reference-token").length, 1);
    assert.equal(editor()!.querySelector('[data-reference-kind="file"]'), null);
    assert.equal(saves, 0);
  });
});

test("missing queue excerpt source keeps the editor and unsaved reference draft open", async () => {
  await withRuntimeDom(async (h) => {
    let saves = 0;
    await h.render(
      referencedQueue(
        referenceMessage("保留问题", [queueReferences[1]!], "queue-client-0"),
      ),
      {
        onReadAttachment: readImage,
        onEditQueued: async (p) => {
          saves++;
          return result(p);
        },
      },
    );
    await h.click('[data-queue-id="queue-0"] .queue-row-edit');
    await changeText("尚未保存");
    await h.click(".queue-editor-reference-rail .reference-token-details");
    await h.click(".reference-open-source");
    await flush();
    assert.ok(editor());
    assert.equal(text().value, "尚未保存");
    assert.ok(document.querySelector(".reference-source-error"));
    assert.equal(saves, 0);
  });
});

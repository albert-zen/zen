import "./dom-primitives.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ContextItem } from "../../../src/item-list.js";
import type { Thread } from "../src/protocol-client/index.js";
import { ImagePreparationNotice } from "../src/renderer/src/ImagePreparationNotice.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";

const input = {
  id: "input",
  threadId: "thread",
  createdAt: "2026-11-04T00:00:00Z",
  kind: "message",
  role: "user",
  source: { kind: "user_message", sequence: 0 },
  content: { text: "Synthetic image input", parts: [] },
} as ContextItem;

function notice(sampleId: string, width: number): ContextItem {
  const original = {
    type: "attachment",
    sha256: "synthetic-original",
    mediaType: "image/png",
    byteLength: 100,
    width: 4000,
    height: 3000,
  };
  return {
    ...input,
    id: `notice-${sampleId}`,
    source: {
      kind: "image_preparation",
      sequence: 1,
      metadata: {
        onlySampleId: sampleId,
        imagePreparation: {
          profile: "codex-high-v1",
          occurrence: {
            itemId: input.id,
            field: "parts",
            partIndex: 0,
            sha256: original.sha256,
          },
          originalAttachment: original,
        },
      },
    },
    content: {
      text: "Synthetic image preparation",
      parts: [
        {
          type: "image",
          attachment: {
            ...original,
            sha256: `synthetic-prepared-${width}`,
            width,
            height: 600,
          },
        },
      ],
    },
  } as ContextItem;
}

test("unchanged 10000-item history does not repeat image projection on parent renders", async (t) => {
  let metadataReads = 0;
  const items = Object.freeze(
    Array.from({ length: 10_000 }, (_, index) =>
      Object.freeze({
        ...input,
        id: `synthetic-${index}`,
        source: Object.freeze({
          ...input.source,
          get metadata() {
            metadataReads++;
            return undefined;
          },
        }),
      }),
    ),
  );
  await withDom(async (root) => {
    for (let render = 0; render < 4; render++) {
      metadataReads = 0;
      await act(async () =>
        root.render(
          createElement(
            "div",
            { "data-parent-render": render },
            createElement(ImagePreparationNotice, { items }),
          ),
        ),
      );
      assert.equal(metadataReads, render === 0 ? items.length : 0);
      assert.ok(
        document.querySelector("aside") === null,
        "Unchanged history without preparation renders no notice",
      );
      t.diagnostic(`Parent render ${render}: ${metadataReads} metadata reads`);
    }
  });
});

test("new ItemList arrays refresh same-sample replacements, native appends and clearing", async () => {
  await withDom(async (root) => {
    const render = async (items: readonly ContextItem[]) =>
      act(async () =>
        root.render(createElement(ImagePreparationNotice, { items })),
      );
    await render([]);
    assert.ok(
      document.querySelector("aside") === null,
      "Empty initial history renders no notice",
    );

    const initial = [input, notice("sample-a", 1600)];
    Object.freeze(initial);
    await render(initial);
    assert.match(document.body.textContent ?? "", /4000 × 3000 → 1600 × 600/);

    const replaced = [input, notice("sample-a", 1200)];
    Object.freeze(replaced);
    await render(replaced);
    assert.match(document.body.textContent ?? "", /4000 × 3000 → 1200 × 600/);
    assert.doesNotMatch(document.body.textContent ?? "", /1600 × 600/);

    const previous: Thread = {
      id: "thread",
      sessionId: "thread",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      isPinned: false,
      modelProvider: "synthetic",
      createdAt: 0,
      updatedAt: 0,
      recencyAt: null,
      status: { type: "idle" },
      path: null,
      cwd: "/synthetic",
      cliVersion: "zen/0.1.0",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
      itemList: replaced,
    };
    const event = {
      type: "context_item_completed" as const,
      threadId: "thread",
      item: notice("sample-b", 800),
    };
    const appended = applyNativeThreadEvent(previous, event);
    assert.notEqual(appended.itemList, replaced);
    assert.equal(previous.itemList, replaced);
    assert.equal(replaced.length, 2);
    assert.equal(applyNativeThreadEvent(appended, event), appended);
    await render(appended.itemList!);
    assert.match(document.body.textContent ?? "", /4000 × 3000 → 800 × 600/);
    assert.doesNotMatch(document.body.textContent ?? "", /1200 × 600/);

    await render([input]);
    assert.ok(
      document.querySelector("aside") === null,
      "Removing image preparation removes the notice",
    );
    await render([]);
    assert.ok(
      document.querySelector("aside") === null,
      "Clearing history keeps the notice absent",
    );
  });
});

test("same-input language changes keep image details open and focused without reprojection", async () => {
  let metadataReads = 0;
  const prepared = notice("sample-a", 1600);
  const source = prepared.source;
  const items = Object.freeze([
    input,
    {
      ...prepared,
      source: {
        ...source,
        get metadata() {
          metadataReads++;
          return source.metadata;
        },
      },
    },
  ]);
  await withDom(async (root) => {
    await act(async () =>
      root.render(createElement(ImagePreparationNotice, { items })),
    );
    const details = document.querySelector("details");
    const summary = details?.querySelector("summary");
    assert.ok(
      details !== null && summary !== null && summary !== undefined,
      "The image notice has a details disclosure and summary",
    );
    details.open = true;
    summary.focus();
    assert.match(document.body.textContent ?? "", /Model image view adjusted/);
    metadataReads = 0;
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.match(document.body.textContent ?? "", /模型图片视图已调整/);
    assert.equal(metadataReads, 0);
    assert.ok(
      document.querySelector("details") === details,
      "Language changes preserve the existing details element",
    );
    assert.equal(details.open, true);
    assert.ok(
      document.activeElement === summary,
      "Language changes preserve focus on the details summary",
    );
  });
});

async function withDom(run: (root: Root) => Promise<void>): Promise<void> {
  const dom = new JSDOM("<!doctype html><div id=root></div>", {
    url: "http://localhost",
  });
  const previous = { window: globalThis.window, document: globalThis.document };
  const language = i18n.language;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await i18n.changeLanguage("en");
    await run(root);
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage(language);
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

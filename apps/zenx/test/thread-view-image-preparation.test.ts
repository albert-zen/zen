import "./dom-primitives.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttachmentRef } from "../../../src/attachment-ref.js";
import { compileItemList, type ContextItem } from "../../../src/item-list.js";
import { FileItemListStore } from "../../../src/item-list-store.js";
import { imageUnavailableNotice } from "../../../src/image-preparation-notice.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  runtimeMessage,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";

const original: AttachmentRef = {
  type: "attachment",
  sha256: "a".repeat(64),
  mediaType: "image/png",
  byteLength: 100,
  width: 4000,
  height: 3000,
};
const prepared: AttachmentRef = {
  ...original,
  sha256: "b".repeat(64),
  byteLength: 50,
  width: 1600,
  height: 1200,
};
const selection = { providerProfileId: "synthetic", modelId: "image-model" };
const noop = async () => {};

for (const outcome of [
  "prepared",
  "image_decode_failed",
  "image_processing_failed",
] as const) {
  for (const detail of ["ordinary", "unsupported", "unknown"] as const) {
    test(`ThreadView omits ${outcome}/${detail} preparation UI without changing persisted model input`, async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "zenx-no-image-card-"),
      );
      const threadId = "synthetic-image-thread";
      const requestedDetail = detail === "ordinary" ? "high" : "original";
      const base = {
        threadId,
        turnId: "runtime-turn",
        createdAt: "2026-11-03T12:00:00Z",
        kind: "message" as const,
        role: "user" as const,
      };
      const input: ContextItem = {
        ...base,
        id: "original-input",
        source: { kind: "user_message", sequence: 0 },
        content: {
          text: "Original image message",
          parts: [
            { type: "text", text: "Original image message" },
            { type: "image", attachment: original, detail: requestedDetail },
          ],
        },
      };
      const text =
        outcome === "prepared"
          ? "Synthetic model-only image resize notice"
          : imageUnavailableNotice(outcome, original);
      const notice: ContextItem = {
        ...base,
        id: "preparation-notice",
        source: {
          kind: "image_preparation",
          sequence: 1,
          metadata: {
            onlySampleId: "sample",
            selection,
            imagePreparation: {
              profile: "codex-high-v1",
              outcome: outcome === "prepared" ? "prepared" : "unavailable",
              ...(outcome === "prepared" ? {} : { reason: outcome }),
              requestedDetail,
              supportsImageDetailOriginal: detail === "unknown" ? null : false,
              occurrence: {
                itemId: input.id,
                field: "content",
                partIndex: 1,
                sha256: original.sha256,
              },
              originalAttachment: { ...original },
            },
          },
        },
        content: {
          text,
          parts: [
            { type: "text", text },
            ...(outcome === "prepared"
              ? [{ type: "image" as const, attachment: prepared }]
              : []),
          ],
        },
      };
      try {
        const store = new FileItemListStore(directory);
        await store.create(threadId, [input, notice]);
        const itemList = await store.read(threadId);
        const filename = path.join(directory, `${threadId}.jsonl`);
        const persistedBefore = await readFile(filename);
        const itemsBefore = structuredClone(itemList);
        const options = {
          sampleId: "sample",
          selection,
          inputModalities: ["text", "image"],
        };
        const modelBefore = compileItemList(itemList, options);
        assert.match(
          JSON.stringify(modelBefore.messages),
          new RegExp(
            outcome === "prepared" ? "model-only image resize notice" : outcome,
          ),
        );
        const images = modelBefore.messages.flatMap((message) =>
          message.role === "user" && "content" in message
            ? message.content.filter((part) => part.type === "image")
            : [],
        );
        assert.equal(images.length, outcome === "prepared" ? 1 : 0);
        if (images[0]?.type === "image")
          assert.deepEqual(images[0].attachment, prepared);
        const view = runtimeThread(
          [
            {
              type: "userMessage",
              id: input.id,
              clientId: null,
              content: [
                { type: "text", text: input.content.text, text_elements: [] },
              ],
            },
            runtimeMessage("answer", "Existing answer"),
          ],
          "completed",
          threadId,
        );
        view.itemList = itemList;
        // The product's existing canonical attachment path remains authoritative.
        const canonicalItems: NonNullable<typeof view.canonicalItems> = [
          {
            id: input.id,
            threadId,
            turnId: "runtime-turn",
            createdAt: base.createdAt,
            type: "user_message",
            content: input.content.parts,
          },
        ];
        view.canonicalItems = canonicalItems;
        const canonicalBefore = structuredClone(canonicalItems);
        for (const language of ["en", "zh-CN"]) {
          await i18n.changeLanguage(language);
          const html = renderToStaticMarkup(
            createElement(ThreadView, {
              thread: view,
              approvals: [],
              composer: emptyComposerState(),
              onDraftChange: () => {},
              onInterrupt: noop,
              onRespondToApproval: noop,
              onSubmit: noop,
            }),
          );
          assert.match(html, /Original image message/);
          assert.match(html, /Existing answer/);
          assert.match(html, /class="message-images"/);
          assert.doesNotMatch(
            html,
            /image-preparation-notice|image-preparation-fallback|Model image view|Image unavailable to model|View image sizes|模型图片视图|模型无法查看图片|查看图片尺寸|model-only image resize notice|image_decode_failed|image_processing_failed/,
          );
        }
        assert.deepEqual(itemList, itemsBefore);
        assert.deepEqual(compileItemList(itemList, options), modelBefore);
        assert.deepEqual(await readFile(filename), persistedBefore);
        assert.deepEqual(await store.read(threadId), itemsBefore);
        assert.deepEqual(canonicalItems, canonicalBefore);
      } finally {
        await i18n.changeLanguage("en");
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

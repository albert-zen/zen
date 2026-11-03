import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextItem } from "../../../src/item-list.js";
import "../src/renderer/src/i18n.js";
import { ImagePreparationNotice } from "../src/renderer/src/ImagePreparationNotice.js";

const original = {
  type: "attachment",
  sha256: "original-private-hash",
  mediaType: "image/png",
  byteLength: 100,
  width: 4000,
  height: 3000,
};
const prepared = {
  ...original,
  sha256: "prepared-private-hash",
  width: 1600,
  height: 1200,
};
const item = {
  id: "notice",
  threadId: "thread",
  createdAt: "2026-11-03T00:00:00Z",
  kind: "message",
  role: "user",
  source: {
    kind: "image_preparation",
    sequence: 1,
    metadata: {
      onlySampleId: "sample",
      selection: { providerProfileId: "provider", modelId: "model" },
      imagePreparation: {
        profile: "codex-high-v1",
        requestedDetail: "original",
        supportsImageDetailOriginal: null,
        occurrence: {
          itemId: "input",
          field: "parts",
          partIndex: 0,
          sha256: original.sha256,
        },
        originalAttachment: original,
      },
    },
  },
  content: {
    text: "private model notice",
    parts: [
      { type: "text", text: "private model notice" },
      { type: "image", attachment: prepared },
    ],
  },
} as ContextItem;

const input = {
  id: "input",
  threadId: "thread",
  createdAt: "2026-11-03T00:00:00Z",
  kind: "message",
  role: "user",
  source: { kind: "user_message", sequence: 0 },
  content: { text: "image", parts: [] },
} as ContextItem;

test("notice renders compact accessible text without exposing raw refs or model notice", () => {
  const html = renderToStaticMarkup(
    createElement(ImagePreparationNotice, { items: [input, item, item] }),
  );
  assert.match(html, /Model image view adjusted \(1\)/);
  assert.match(html, /4000 × 3000 → 1600 × 1200/);
  assert.match(html, /support is unknown/);
  assert.doesNotMatch(
    html,
    /private-hash|private model notice|providerProfileId|attachment.*sha256/,
  );
});

test("empty history renders no notice", () => {
  assert.equal(
    renderToStaticMarkup(createElement(ImagePreparationNotice, { items: [] })),
    "",
  );
});

test("mixed unknown and unsupported original-detail fallbacks both render", () => {
  const secondInput = { ...input, id: "second" } as ContextItem;
  const second = {
    ...item,
    id: "notice-second",
    source: {
      ...item.source,
      metadata: {
        ...item.source.metadata,
        imagePreparation: {
          ...(item.source.metadata?.imagePreparation as Record<
            string,
            unknown
          >),
          supportsImageDetailOriginal: false,
          occurrence: {
            itemId: "second",
            field: "parts",
            partIndex: 0,
            sha256: original.sha256,
          },
        },
      },
    },
  } as ContextItem;
  const html = renderToStaticMarkup(
    createElement(ImagePreparationNotice, {
      items: [input, item, secondInput, second],
    }),
  );
  assert.match(html, /Model image view adjusted \(2\)/);
  assert.match(html, /support is unknown/);
  assert.match(html, /unsupported by this model/);
});

test("unavailable-only notice says no pixels sent and never claims high fallback", () => {
  const unavailable = {
    ...item,
    source: {
      ...item.source,
      metadata: {
        ...item.source.metadata,
        imagePreparation: {
          ...(item.source.metadata?.imagePreparation as Record<
            string,
            unknown
          >),
          outcome: "unavailable",
          reason: "image_decode_failed",
        },
      },
    },
    content: {
      text: "private path /secret/image.png",
      parts: [{ type: "text", text: "private path /secret/image.png" }],
    },
  } as ContextItem;
  const html = renderToStaticMarkup(
    createElement(ImagePreparationNotice, { items: [input, unavailable] }),
  );
  assert.match(html, /Image unavailable to model \(1\)/);
  assert.match(html, /No image pixels were sent/);
  assert.match(html, /could not decode image/);
  assert.doesNotMatch(
    html,
    /high-detail view|Model image view adjusted|\/secret\/image.png|private-hash/,
  );
});

test("mixed notice counts prepared and unavailable separately", () => {
  const secondInput = { ...input, id: "second" } as ContextItem;
  const unavailable = {
    ...item,
    id: "unavailable",
    source: {
      ...item.source,
      metadata: {
        ...item.source.metadata,
        imagePreparation: {
          ...(item.source.metadata?.imagePreparation as Record<
            string,
            unknown
          >),
          occurrence: {
            itemId: "second",
            field: "parts",
            partIndex: 0,
            sha256: original.sha256,
          },
          outcome: "unavailable",
          reason: "image_processing_failed",
        },
      },
    },
    content: {
      text: "private notice",
      parts: [{ type: "text", text: "private notice" }],
    },
  } as ContextItem;
  const html = renderToStaticMarkup(
    createElement(ImagePreparationNotice, {
      items: [input, item, secondInput, unavailable],
    }),
  );
  assert.match(html, /1 prepared, 1 unavailable/);
  assert.match(html, /could not prepare image/);
  assert.match(html, /bounded high-detail view was used/);
  assert.doesNotMatch(html, /private notice/);
});

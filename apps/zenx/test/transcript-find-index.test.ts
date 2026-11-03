import assert from "node:assert/strict";
import test from "node:test";
import {
  markdownFindBlocks,
  indexTurnFindText,
  searchTranscript,
  stepTranscriptFind,
} from "../src/renderer/src/transcript-find-index.js";
import type { Turn } from "../src/protocol-client/index.js";

test("search indexes rendered CommonMark/GFM text, not syntax, URLs, or image metadata", () => {
  const blocks = markdownFindBlocks(
    "Hello **bold** [label](https://private.example) &amp; `code`\n\n![unmounted alt](image.png)\n\n| A | B |\n| - | - |\n| C | D |",
  );
  assert.deepEqual(blocks, ["Hello bold label & code", "A", "B", "C", "D"]);
});
test("whole-data search finds hidden historical bodies and plain tool text with disclosure identities", () => {
  const turn = {
    id: "far-turn",
    status: "completed",
    items: [
      {
        id: "user",
        type: "userMessage",
        clientId: null,
        content: [{ type: "text", text: "Needle **one**", text_elements: [] }],
      },
      {
        id: "reason",
        type: "reasoning",
        summary: ["summary-only"],
        content: ["needle two"],
      },
      {
        id: "call",
        type: "commandExecution",
        command: "echo needle",
        aggregatedOutput: "needle three",
        exitCode: 0,
      },
      {
        id: "structured-fallback",
        type: "commandExecution",
        command: "custom",
        structuredContent: { secret: "needle" },
        aggregatedOutput: "needle hidden",
      },
      {
        id: "answer",
        type: "agentMessage",
        text: "needle final. Needle final.",
      },
    ],
  } as Turn;
  const entries = indexTurnFindText(turn);
  const matches = searchTranscript(entries, "needle");
  assert.deepEqual(
    matches.map(({ entry, occurrence }) => [
      entry.itemId,
      entry.field,
      occurrence,
    ]),
    [
      ["user", "body", 0],
      ["reason", "body", 0],
      ["call", "command", 0],
      ["call", "output", 0],
      ["structured-fallback", "tool-structured", 0],
      ["structured-fallback", "output", 0],
      ["answer", "body", 0],
      ["answer", "body", 1],
    ],
  );
  assert.ok(
    matches[1]!.entry.disclosures.includes(
      JSON.stringify(["item", "far-turn", "reason"]),
    ),
  );
  assert.equal(searchTranscript(entries, "**one**").length, 0);
  assert.equal(searchTranscript(entries, "summary-only").length, 0);
  assert.equal(
    searchTranscript(entries, "needle hidden").length,
    1,
    "known fallback text is actually rendered, not an opaque plugin substitute",
  );
});
test("literal matching is non-overlapping, whitespace normalized, Unicode-safe, and navigation wraps", () => {
  const entries = [
    {
      turnId: "t",
      itemId: "i",
      field: "body" as const,
      disclosures: [],
      blocks: ["aaa a+b İ 中 文"],
    },
  ];
  assert.equal(searchTranscript(entries, "aa").length, 1);
  assert.equal(searchTranscript(entries, "a+b").length, 1);
  assert.equal(searchTranscript(entries, "中\n 文").length, 1);
  assert.equal(searchTranscript(entries, " ").length, 0);
  assert.equal(stepTranscriptFind(0, 3, -1), 2);
  assert.equal(stepTranscriptFind(2, 3, 1), 0);
});

test("5000-turn open Find reuses old text parses across new Send and live turn replacement", async () => {
  const { createTranscriptFindIndexer } =
    await import("../src/renderer/src/transcript-find-index.js");
  let parses = 0;
  const index = createTranscriptFindIndexer((source) => {
    parses++;
    return markdownFindBlocks(source);
  });
  const canonical = new Map();
  const turns = Array.from(
    { length: 5000 },
    (_, i) =>
      ({
        id: `turn-${i}`,
        status: "completed",
        items: [{ id: `item-${i}`, type: "agentMessage", text: `Answer ${i}` }],
      }) as Turn,
  );
  assert.equal(parses, 0, "creating closed Find performs zero reads/parses");
  assert.equal(index(turns, canonical).length, 5000);
  assert.equal(parses, 5000);
  index([...turns], canonical);
  assert.equal(
    parses,
    5000,
    "new turns array does not reparse immutable history",
  );
  const active = {
    id: "active",
    status: "inProgress",
    items: [
      {
        id: "new-user",
        type: "userMessage",
        clientId: null,
        content: [{ type: "text", text: "New Send", text_elements: [] }],
      },
    ],
  } as Turn;
  index([...turns, active], canonical);
  assert.equal(parses, 5001, "new Send parses exactly one new item");
  const streamed = {
    ...active,
    items: [
      ...active.items,
      { id: "new-answer", type: "agentMessage", text: "stream" },
    ],
  } as Turn;
  index([...turns, streamed], canonical);
  assert.equal(
    parses,
    5002,
    "changed long turn retains its unchanged item text",
  );
  index(
    [
      ...turns,
      {
        ...streamed,
        items: [
          ...streamed.items.slice(0, -1),
          { ...streamed.items.at(-1)!, text: "stream delta" },
        ],
      } as Turn,
    ],
    canonical,
  );
  assert.equal(parses, 5003, "stream delta reparses only the changed item");
});

test("canonical input and visible reference labels are searched, never serialized reference metadata", async () => {
  const { referenceMessage } =
    await import("../src/renderer/src/reference-draft.js");
  const encoded = referenceMessage(
    "Ask \uFFFC now",
    [
      {
        kind: "message",
        threadId: "hidden-origin-thread",
        id: "hidden-source-id",
        name: "source",
        cwd: "/private/workspace",
        excerpt: "**literal** quote",
        position: 4,
      },
    ],
    "client",
  );
  const item = {
    type: "userMessage",
    id: "input",
    clientId: "client",
    content: [{ type: "text", text: "stale projection", text_elements: [] }],
  } as const;
  const turn = {
    id: "t",
    status: "completed",
    items: [item],
  } as unknown as Turn;
  const canonical = {
    inputs: new Map([
      [
        "input",
        {
          id: "input",
          type: "user_message",
          text: encoded,
          clientId: "client",
        },
      ],
    ]),
  } as unknown as import("../src/renderer/src/turn-canonical-presentation.js").TurnCanonicalPresentation;
  const entries = indexTurnFindText(turn, canonical);
  assert.deepEqual(entries[0]!.blocks, ["Ask **literal** quote now"]);
  assert.equal(
    searchTranscript(entries, "**literal**").length,
    1,
    "reference label is literal, not reparsed Markdown",
  );
  for (const hidden of [
    "stale projection",
    "hidden-origin-thread",
    "hidden-source-id",
    "/private/workspace",
    "zenx-reference-message",
  ])
    assert.equal(searchTranscript(entries, hidden).length, 0);
});

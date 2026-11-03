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
        id: "opaque",
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
  assert.equal(searchTranscript(entries, "needle hidden").length, 0);
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

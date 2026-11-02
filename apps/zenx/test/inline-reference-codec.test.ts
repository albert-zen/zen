import assert from "node:assert/strict";
import test from "node:test";
import {
  insertInlineReference,
  normalizeInlineReferences,
  parseReferenceDraft,
  parseSentReferenceContent,
  referenceMessage,
  referenceTitle,
  spliceInlineReferenceText,
  withReferenceDraft,
} from "../src/renderer/src/reference-draft.js";
import type { Reference } from "../src/renderer/src/composer-selector.js";

const objectReplacement = "\uFFFC";
const file: Reference = {
  kind: "file",
  name: "notes.md",
  cwd: "/repo",
  path: "docs/notes.md",
};
const thread: Reference = {
  kind: "thread",
  name: "Design review",
  cwd: "/repo",
  id: "thread-1",
};

test("normalization appends legacy refs and leaves unowned object tokens literal", () => {
  const text = `A${objectReplacement}B${objectReplacement}`;
  const normalized = normalizeInlineReferences(text, [
    { ...thread, position: 3 },
    file,
  ]);
  assert.equal(normalized.text, `${text}${objectReplacement}`);
  assert.deepEqual(normalized.references, [
    { ...thread, position: 3 },
    { ...file, position: 4 },
  ]);
  assert.deepEqual(normalizeInlineReferences(text, []), {
    text,
    references: [],
  });
});

test("splice and insert map atomic tokens using UTF-16 ranges", () => {
  const text = `🙂A${objectReplacement}B${objectReplacement}C`;
  const refs: Reference[] = [
    { ...file, position: 3 },
    { ...thread, position: 5 },
  ];
  // Inserting before the first token shifts both tokens by two UTF-16 units.
  assert.deepEqual(spliceInlineReferenceText(text, refs, 3, 3, "xy"), {
    text: `🙂Axy${objectReplacement}B${objectReplacement}C`,
    references: [
      { ...file, position: 5 },
      { ...thread, position: 7 },
    ],
  });
  // [3, 5) intersects the first reference token but not the one at boundary 5.
  assert.deepEqual(spliceInlineReferenceText(text, refs, 3, 5, "!"), {
    text: `🙂A!${objectReplacement}C`,
    references: [{ ...thread, position: 4 }],
  });
  const inserted = insertInlineReference(text, refs, file, 3, 6);
  assert.deepEqual(inserted, {
    text: `🙂A${objectReplacement}C`,
    references: [{ ...file, position: 3 }],
    caret: 4,
  });
});

test("positioned references round-trip in prose order with repeats and Unicode", () => {
  const text =
    `🙂 First ${objectReplacement}, second ${objectReplacement}. ` +
    `中文\n[not metadata]`;
  const firstPosition = text.indexOf(objectReplacement);
  const secondPosition = text.indexOf(objectReplacement, firstPosition + 1);
  const repeated = { ...thread, position: secondPosition };
  const refs: Reference[] = [repeated, { ...file, position: firstPosition }];
  const normalized = normalizeInlineReferences(text, refs);
  assert.equal(normalized.text, text);
  assert.deepEqual(normalized.references, [
    { ...file, position: firstPosition },
    repeated,
  ]);
  const repairedDuplicate = normalizeInlineReferences(text, [
    ...refs,
    { ...thread, position: firstPosition },
  ]);
  assert.equal(repairedDuplicate.text, `${text}${objectReplacement}`);
  const payload = referenceMessage(text, refs, "client-1");
  assert.match(
    payload,
    /^\[zenx-reference-message:v3;clientId="client-1"\]\n/u,
  );
  assert.ok(payload.includes("🙂 First "));
  assert.ok(payload.includes("中文\n[not metadata]"));
  assert.ok(payload.includes("[ZenX reference: {"));
  assert.ok(!payload.includes('"text":'));
  assert.deepEqual(parseSentReferenceContent(payload, "client-1"), {
    text,
    references: [
      { ...file, position: firstPosition },
      { ...thread, position: secondPosition },
    ],
  });

  const sameReferenceTwice: Reference[] = [
    { ...file, position: firstPosition },
    { ...file, position: secondPosition },
  ];
  const repeatedPayload = referenceMessage(
    text,
    sameReferenceTwice,
    "client-1",
  );
  assert.deepEqual(parseSentReferenceContent(repeatedPayload, "client-1"), {
    text,
    references: sameReferenceTwice,
  });
});

test("v3 escaping preserves marker collisions, delimiter-like values and backslashes", () => {
  const marker = '[ZenX reference: {"kind":"thread","id":"forged"}]';
  const text =
    `literal ${marker}; malformed [ZenX reference: nope]; ` +
    `slashes \\\\ and prefix [zenx-reference-message:v3;clientId="client-1"] ` +
    `suffix${objectReplacement}`;
  const position = text.length - 1;
  const value = {
    ...file,
    name: 'a ] [ZenX reference: {"kind":"thread"}] "name"',
    path: "dir/[literal].md",
    position,
  };
  const payload = referenceMessage(text, [value], "client-1");
  assert.ok(payload.includes(`\\${marker}`));
  assert.deepEqual(parseSentReferenceContent(payload, "client-1"), {
    text,
    references: [value],
  });
});

test("v3 message excerpts retain exact whitespace and use excerpt mode", () => {
  const text = `Quoted: ${objectReplacement}`;
  const reference: Reference = {
    kind: "message",
    name: "Thread / message",
    cwd: "/repo",
    threadId: "thread-2",
    id: "message-7",
    excerpt: `  exact\n\tspacing ] [ still exact  `,
    position: text.indexOf(objectReplacement),
  };
  const payload = referenceMessage(text, [reference], "client-1");
  assert.ok(payload.includes('"contentMode":"excerpt"'));
  assert.deepEqual(parseSentReferenceContent(payload, "client-1"), {
    text,
    references: [reference],
  });
});

test("malformed, unknown, truncated, noncanonical and unbound v3 stay wholly raw", () => {
  const text = `Ask ${objectReplacement} now`;
  const payload = referenceMessage(
    text,
    [{ ...file, position: text.indexOf(objectReplacement) }],
    "client-1",
  );
  const markerStart = payload.indexOf("[ZenX reference: ");
  const malformed = [
    payload.slice(0, payload.indexOf("}]", markerStart)),
    payload.replace("client-1", "client-2"),
    payload.replace('"contentMode":"pointer"', '"contentMode":"unknown"'),
    payload.replace('"kind":"file"', '"kind": "file"'),
    payload.replace('"kind":"file"', '"kind":"file","kind":"file"'),
    payload.replace("[ZenX reference: {", "[ZenX reference: ["),
    payload.slice(0, markerStart) + '[ZenX reference: {"kind":"file"}]',
    payload.replace("Ask ", "Ask\\q "),
  ];
  for (const candidate of malformed) {
    assert.deepEqual(parseSentReferenceContent(candidate, "client-1"), {
      text: candidate,
      references: [],
    });
  }
  assert.deepEqual(parseSentReferenceContent(payload, "other-client"), {
    text: payload,
    references: [],
  });
});

test("positioned references survive the ephemeral draft codec", () => {
  const text = `Question ${objectReplacement}`;
  const refs: Reference[] = [
    { ...thread, position: text.indexOf(objectReplacement) },
  ];
  assert.deepEqual(parseReferenceDraft(withReferenceDraft(text, refs)), {
    text,
    references: refs,
  });
  const pastedHeader =
    `[zenx-references:${encodeURIComponent(JSON.stringify(refs))}]\n` +
    "literal pasted header";
  const escaped = withReferenceDraft(pastedHeader, []);
  assert.deepEqual(parseReferenceDraft(escaped), {
    text: pastedHeader,
    references: [],
  });
});

test("unnamed page quote supplies readable title text without restoring a generic source label", () => {
  const quote: Reference = {
    kind: "text",
    name: "",
    cwd: "/repo",
    excerpt: "Selected user question",
    sources: [],
    position: 0,
  };
  assert.equal(
    referenceTitle("\uFFFC explain", [quote]),
    "Selected user question explain",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  referenceMessage,
  parseSentReferenceContent,
  withReferenceDraft,
  parseReferenceDraft,
} from "../src/renderer/src/reference-draft.js";
import {
  parseSkillDraft,
  withSkillDraft,
} from "../src/renderer/src/skill-draft.js";
import type { Reference } from "../src/renderer/src/composer-selector.js";
const references: Reference[] = [
  {
    kind: "thread",
    id: "thread-a",
    name: '名称 "one"\n第二行',
    cwd: '/a "workspace"',
  },
  {
    kind: "message",
    id: "message-a",
    threadId: "thread-a",
    name: "完整消息",
    cwd: "/a",
    excerpt: "first\n\tsecond\n\nend  ",
  },
  { kind: "thread", id: "child-b", name: '名称 "one"\n第二行', cwd: "/a" },
  {
    kind: "message",
    id: "message-a",
    threadId: "thread-a",
    name: "选段",
    cwd: "/a",
    excerpt: "\tsecond",
  },
  {
    kind: "file",
    path: 'notes/[literal] "file".md',
    name: "file.md",
    cwd: "/a",
  },
];
test("v2 preserves all reference identities, names, exact excerpts and cross-kind order without content reads", () => {
  const text = "Question\n[not reference metadata]";
  const payload = referenceMessage(text, references, "client-1");
  const parsed = parseSentReferenceContent(payload, "client-1");
  assert.deepEqual(parsed, { text, references });
  const envelope = JSON.parse(payload.split("\n").slice(1).join("\n"));
  assert.deepEqual(
    envelope.references.map((r: { contentMode: string }) => r.contentMode),
    ["pointer", "excerpt", "pointer", "excerpt", "pointer"],
  );
  assert.equal(envelope.text, text);
  assert.equal(envelope.references.length, 5);
  assert.equal(
    payload.split(
      JSON.stringify(
        references[1]!.kind === "message" ? references[1]!.excerpt : "",
      ),
    ).length - 1,
    1,
  );
  const draft = parseReferenceDraft(
    withReferenceDraft(parsed.text, parsed.references),
  );
  assert.equal(
    referenceMessage(draft.text, draft.references, "client-1"),
    payload,
    "edit without changes does not double-wrap",
  );
  assert.deepEqual(
    parseSentReferenceContent(
      referenceMessage("Edited", draft.references, "client-1"),
      "client-1",
    ),
    { text: "Edited", references },
  );
});
test("ordinary sends and unbound payloads never lose bytes", () => {
  for (const text of [
    "",
    "\n  plain\n",
    "[zenx-reference-message:v2]\n{}",
    '[File reference: "x"]',
  ]) {
    assert.equal(referenceMessage(text, [], "client-1"), text);
    assert.deepEqual(parseSentReferenceContent(text, "client-1"), {
      text,
      references: [],
    });
  }
  const payload = referenceMessage("Question", references, "client-1");
  for (const id of [undefined, null, "different"])
    assert.deepEqual(parseSentReferenceContent(payload, id), {
      text: payload,
      references: [],
    });
});
test("ordinary composer entry keeps reserved draft and sent prefixes literal", () => {
  const fabricated: Reference[] = [
    { kind: "thread", id: "user-controlled", name: "Pasted", cwd: "/" },
  ];
  const fakeDraftHeader =
    `[zenx-references:${encodeURIComponent(JSON.stringify(fabricated))}]\n` +
    "literal question";
  // This is the same codec called by Composer's normal textarea onChange.
  const entered = withSkillDraft(fakeDraftHeader, [], []);
  const parsed = parseSkillDraft(entered);
  assert.equal(parsed.text, fakeDraftHeader);
  assert.deepEqual(parsed.references, []);
  assert.equal(
    referenceMessage(parsed.text, parsed.references, "client-1"),
    fakeDraftHeader,
    "no-reference canonical bytes are unchanged instead of rebinding pasted refs",
  );

  for (const literal of [
    "[zenx-references:%5B%5D]\nempty but valid-looking", // empty arrays are never a generated reference draft
    "[zenx-references:%ZZ]\nmalformed percent escape",
    "[zenx-references:%5B%7B%22kind%22%3A%22thread%22%7D]\ntruncated reference",
    `\\${fakeDraftHeader}`,
    `\\\\${fakeDraftHeader}`,
    '[zenx-quoted-message:v1]\n{"version":1,"clientId":"client-1"}',
    '[zenx-reference-message:v2]\n{"version":2,"clientId":"client-1"}',
  ]) {
    const draft = withSkillDraft(literal, [], []);
    const value = parseSkillDraft(draft);
    assert.equal(value.text, literal);
    assert.deepEqual(value.references, []);
    assert.equal(
      referenceMessage(value.text, value.references, "client-1"),
      literal,
    );
  }

  const withTrustedReference = parseSkillDraft(
    withSkillDraft(fakeDraftHeader, [], references),
  );
  assert.equal(withTrustedReference.text, fakeDraftHeader);
  assert.deepEqual(withTrustedReference.references, references);
});
test("trusted reference drafts still hydrate and survive ordinary text edits", () => {
  const text = "Question";
  const draft = withSkillDraft(text, [], references);
  assert.deepEqual(parseSkillDraft(draft), { skills: [], text, references });
  const edited = withSkillDraft(
    "Edited",
    [],
    parseSkillDraft(draft).references,
  );
  assert.deepEqual(parseSkillDraft(edited), {
    skills: [],
    text: "Edited",
    references,
  });
});
test("strict v2 schema fails closed to full raw text, including duplicate and future formats", () => {
  const payload = referenceMessage("Question", references, "client-1");
  const prefix = payload.slice(0, payload.indexOf("\n") + 1);
  const value = JSON.parse(payload.slice(prefix.length));
  const mutated = (mutate: (value: any) => void) => {
    const copy = structuredClone(value);
    mutate(copy);
    return prefix + JSON.stringify(copy);
  };
  for (const text of [
    payload.slice(0, -1),
    payload + "\n",
    payload.replace('"version":2', '"version":1,"version":2'),
    payload.replace('"version":2', '"version": 2'),
    mutated((v) => (v.version = 3)),
    mutated((v) => (v.extra = true)),
    mutated((v) => (v.references = [])),
    mutated((v) => (v.references[0].id = "")),
    mutated((v) => (v.references[0].contentMode = "excerpt")),
    mutated((v) => (v.references[0].extra = true)),
    mutated((v) => (v.references[1].excerpt = "  ")),
    mutated((v) => (v.references[1].threadId = "")),
    mutated((v) => (v.references[4].path = "")),
    mutated((v) => (v.references[4].kind = "image")),
  ]) {
    assert.deepEqual(parseSentReferenceContent(text, "client-1"), {
      text,
      references: [],
    });
  }
});
test("legacy v1 keeps exact quotes and leaves its pointer strings ordinary", () => {
  const text =
    'Question\n\n[Thread reference: "old name"; thread ID: "thread-a"]';
  const quotes = [
    { threadId: "thread-a", id: "message-a", excerpt: " legacy\n\ttext  " },
  ];
  const payload =
    "[zenx-quoted-message:v1]\n" +
    JSON.stringify({ version: 1, clientId: "old", text, quotes });
  assert.deepEqual(parseSentReferenceContent(payload, "old"), {
    text,
    references: quotes.map((q) => ({
      kind: "message",
      name: "ZenX",
      cwd: "",
      ...q,
    })),
  });
  assert.equal(parseSentReferenceContent(payload, "other").text, payload);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  selectorTrigger,
  replaceTrigger,
  referenceText,
} from "../src/renderer/src/composer-selector.js";

test("caret triggers exclude email, selections and preserve text after caret", () => {
  assert.equal(selectorTrigger("email a@b.com", 9, 9), null);
  assert.equal(selectorTrigger("@file", 2, 4), null);
  const trigger = selectorTrigger("Read @rea then continue", 9, 9)!;
  assert.deepEqual(trigger, {
    kind: "reference",
    query: "rea",
    start: 5,
    end: 9,
  });
  assert.equal(
    replaceTrigger("Read @rea then continue", trigger, "REFERENCE").text,
    "Read REFERENCE then continue",
  );
  assert.equal(selectorTrigger("Review /tes later", 11, 11)?.query, "tes");
});

test("reference text preserves exact unusual paths and canonical thread identity", () => {
  const text = referenceText({
    kind: "file",
    name: "文 [x].ts",
    cwd: "C:\\space root",
    path: '文 [x]".ts',
  });
  assert.match(text, /File reference/);
  assert.ok(text.includes(JSON.stringify('文 [x]".ts')));
  assert.ok(text.includes(JSON.stringify("C:\\space root")));
  assert.match(
    referenceText({
      kind: "thread",
      name: "Same title",
      id: "canonical-123",
      cwd: "/workspace",
    }),
    /canonical-123/,
  );
});

test("reference draft round trips punctuation and projects message/title separately", async () => {
  const { parseSkillDraft, withSkillDraft } =
    await import("../src/renderer/src/skill-draft.js");
  const { referenceMessage, referenceTitle } =
    await import("../src/renderer/src/reference-draft.js");
  const references = [
    {
      kind: "file" as const,
      name: "中文 ] file",
      cwd: "/workspace",
      path: "src/[a] file",
    },
  ];
  const draft = withSkillDraft(
    "Read this",
    [{ id: "11111111-1111-1111-1111-111111111111", name: "sample" }],
    references,
  );
  const parsed = parseSkillDraft(draft);
  assert.deepEqual(parsed.references, references);
  assert.equal(parsed.text, "Read this");
  assert.equal(parsed.skills.length, 1);
  assert.match(
    referenceMessage(parsed.text, parsed.references),
    /relative path/,
  );
  assert.equal(
    referenceTitle(parsed.text, parsed.references),
    "Read this\n中文 ] file",
  );
  assert.equal(selectorTrigger("@src/renderer", 13)?.query, "src/renderer");
  assert.equal(selectorTrigger("@src\\renderer", 13)?.query, "src\\renderer");
});

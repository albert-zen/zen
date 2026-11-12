import assert from "node:assert/strict";
import test from "node:test";
import { chooseSideChatQuoteTarget } from "../src/renderer/src/side-chat-quote-target.js";
import { SideChatDrafts } from "../src/renderer/src/side-chat-drafts.js";
import { editComposer } from "../src/renderer/src/composer-state.js";
import { addMessageQuote } from "../src/renderer/src/message-quote.js";
import {
  parseSkillDraft,
  withSkillDraft,
} from "../src/renderer/src/skill-draft.js";

test("side quote routing chooses selected, sole, or requires explicit disambiguation", () => {
  const a = { id: "custom:side-chat-draft-a" },
    b = { id: "thread:b" };
  assert.equal(chooseSideChatQuoteTarget([a, b], b.id), b);
  assert.equal(chooseSideChatQuoteTarget([a], "closed-tab"), a);
  assert.equal(chooseSideChatQuoteTarget([a, b], "file:readme"), null);
  assert.equal(chooseSideChatQuoteTarget([], undefined), null);
  assert.equal(chooseSideChatQuoteTarget([a, b], "closed-tab"), null);
});

test("side quote insertion preserves target draft and source identity across repeated actions", () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "side-draft",
  );
  const draft = drafts.open("main", { itemId: "source" });
  const existing = {
    kind: "thread" as const,
    name: "Other",
    cwd: "/work",
    id: "other",
  };
  drafts.updateComposer(draft.id, (state) =>
    editComposer(state, withSkillDraft("My question", [], [existing])),
  );
  const quote = {
    kind: "message" as const,
    name: "ZenX",
    cwd: "/work",
    threadId: "main",
    id: "source",
    excerpt: "Exact selected text",
  };
  for (let i = 0; i < 2; i++)
    drafts.updateComposer(draft.id, (state) =>
      editComposer(state, addMessageQuote(state.draft.text, quote)),
    );
  const parsed = parseSkillDraft(draft.composer.draft.text);
  assert.equal(parsed.text, "My question");
  assert.deepEqual(parsed.references, [existing, quote]);
  assert.equal(draft.threadId, undefined);
  assert.equal(draft.sending, false);
  assert.equal(draft.composer.submission, null);
});

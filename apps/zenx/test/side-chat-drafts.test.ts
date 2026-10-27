import assert from "node:assert/strict";
import test from "node:test";
import { SideChatDrafts } from "../src/renderer/src/side-chat-drafts.js";
import { editComposer } from "../src/renderer/src/composer-state.js";

test("opening/closing and empty Send never create a real child", async () => {
  let creates = 0;
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent", { boundary: "fixed" });
  await drafts.submit(
    "draft",
    async () => {
      creates++;
      return "child";
    },
    async () => {},
  );
  drafts.close("draft");
  assert.equal(creates, 0);
  assert.equal(drafts.entries().length, 0);
});

test("first Send freezes ownership/boundary; duplicate Send is ignored; failed delivery retries same child and message ID", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent-A", { boundary: "open-time" });
  drafts.updateComposer("draft", (s) => editComposer(s, "hello"));
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  const create = async (draft: {
    parentThreadId: string;
    boundary: unknown;
  }) => {
    creates++;
    assert.equal(draft.parentThreadId, "parent-A");
    assert.deepEqual(draft.boundary, { boundary: "open-time" });
    await gate;
    return "child-A";
  };
  const send = async (
    id: string,
    submission: { clientUserMessageId: string },
  ) => {
    assert.equal(id, "child-A");
    sent.push(submission.clientUserMessageId);
    if (sent.length === 1) throw new Error("offline");
  };
  const first = drafts.submit("draft", create, send);
  await drafts.submit("draft", create, send);
  release();
  await first;
  assert.equal(creates, 1);
  assert.equal(drafts.get("draft")?.composer.draft.text, "hello");
  assert.equal(drafts.get("draft")?.composer.submission?.error, "offline");
  await drafts.submit("draft", create, send);
  assert.equal(creates, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(drafts.get("draft")?.composer.draft.text, "");
});

test("unknown create outcome keeps input and blocks another create even after editing", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent", {});
  drafts.updateComposer("draft", (s) => editComposer(s, "keep me"));
  let creates = 0;
  const create = async () => {
    creates++;
    throw new Error("transport lost");
  };
  await drafts.submit("draft", create, async () => {});
  drafts.updateComposer("draft", (s) => editComposer(s, "edited input"));
  await drafts.submit("draft", create, async () => {});
  assert.equal(creates, 1);
  assert.equal(drafts.get("draft")?.composer.draft.text, "edited input");
  assert.equal(drafts.get("draft")?.creationUnconfirmed, true);
});

test("an explicit native rejection permits a safe same-draft creation retry", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  drafts.open("parent", {});
  drafts.updateComposer("draft", (s) => editComposer(s, "hello"));
  let creates = 0;
  const create = async () => {
    if (++creates === 1)
      throw Object.assign(new Error("invalid boundary"), {
        code: -32602,
        data: { zenCode: "fork_boundary_unavailable" },
      });
    return "child";
  };
  await drafts.submit("draft", create, async () => {});
  await drafts.submit("draft", create, async () => {});
  assert.equal(creates, 2);
  assert.equal(drafts.get("draft")?.composer.draft.text, "");
});

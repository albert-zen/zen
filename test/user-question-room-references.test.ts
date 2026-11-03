import assert from "node:assert/strict";
import test from "node:test";
import { AskUserQuestionToolRuntime } from "../src/user-question-tool.js";
import type { ModelReferenceBinding } from "../src/model-references.js";
const content = {
  questions: [{ id: "scope", prompt: "Synthetic scoped Room question" }],
};
const binding: ModelReferenceBinding = {
  ref: "r1",
  ownerThreadId: "actual-author",
  namespace: "rooms",
  kind: "room",
  value: { id: "actual-room" },
};
const invocation = (
  modelReferences: readonly ModelReferenceBinding[] = [],
) => ({
  name: "ask_user_question",
  callId: "provider-call",
  canonicalToolCallId: "canonical-call",
  threadId: "actual-author",
  cwd: "/synthetic",
  signal: new AbortController().signal,
  arguments: { ...content, roomId: "r1" },
  modelReferences,
});

test("Ask resolves normal Room refs from trusted runtime provenance before current-member publication", async () => {
  let allowed = true;
  const publications: unknown[] = [];
  const tool = new AskUserQuestionToolRuntime(async (input) => {
    if (!allowed) throw Error("Not a current Room workspace member");
    publications.push(input);
    return { roomId: input.roomId, questionId: "room-resource", revision: 1 };
  });
  const receipt = await tool.execute(invocation([binding]));
  assert.equal(JSON.parse(receipt.output).roomId, "r1");
  assert.equal(receipt.output.includes("actual-room"), false);
  assert.deepEqual(publications, [
    {
      roomId: "actual-room",
      origin: { threadId: "actual-author", callItemId: "canonical-call" },
      specification: { ...content, answerTemplate: "scope: {{scope}}" },
    },
  ]);
  allowed = false;
  await assert.rejects(
    tool.execute(invocation([binding])),
    /current Room workspace member/,
  );
  assert.equal(publications.length, 1);
});

test("unknown, cross-Thread, wrong-kind and stale Room refs never dispatch", async () => {
  let calls = 0;
  const tool = new AskUserQuestionToolRuntime(async (input) => {
    calls++;
    return {
      roomId: input.roomId,
      questionId: "must-not-publish",
      revision: 1,
    };
  });
  for (const refs of [
    [],
    [{ ...binding, ownerThreadId: "other-thread" }],
    [{ ...binding, namespace: "threads" }],
    [{ ...binding, kind: "workspace" }],
    [{ ...binding, epoch: "retired" }],
    [{ ...binding, value: { roomId: "unbound-room" } }],
  ])
    await assert.rejects(
      tool.execute(invocation(refs)),
      /unavailable|retired|Room/,
    );
  for (const roomId of ["r99", "c1", "s1", "t1"])
    await assert.rejects(
      tool.execute({
        ...invocation([binding]),
        arguments: { ...content, roomId },
      }),
      /unavailable|retired/,
    );
  const forged = invocation();
  forged.arguments = {
    ...forged.arguments,
    modelReferences: [binding],
  } as typeof forged.arguments;
  await assert.rejects(tool.execute(forged), /field|specification/);
  assert.equal(calls, 0);
});

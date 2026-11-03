import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import type { RoomUserQuestionPublicationInput } from "../src/user-question-tool.js";

const specification = {
  questions: [{ id: "scope", prompt: "Synthetic Room question" }],
};
const ask = (roomId?: string) =>
  `!tool ask_user_question ${JSON.stringify({ ...specification, ...(roomId === undefined ? {} : { roomId }) })}`;

async function fixture(
  t: test.TestContext,
  publisher?: (
    input: RoomUserQuestionPublicationInput,
    signal: AbortSignal,
  ) => Promise<{ roomId: string; questionId: string; revision: number }>,
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-host-room-question-"),
  );
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
    ...(publisher === undefined ? {} : { publishRoomQuestion: publisher }),
  });
  t.after(async () => {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  });
  return host;
}

test("explicit Room Ask publishes independent resource with runtime provenance and no Thread question", async (t) => {
  const publications: RoomUserQuestionPublicationInput[] = [];
  const host = await fixture(t, async (input, signal) => {
    signal.throwIfAborted();
    publications.push(input);
    return { roomId: input.roomId, questionId: "room-resource", revision: 1 };
  });
  const thread = await host.startThread();
  await (
    await host.startTurn(thread.id, ask("actual-room"))
  ).done;
  const snapshot = await host.readThread(thread.id);
  const call = snapshot.itemList!.find(
    (item) =>
      item.kind === "tool_call" && item.content.name === "ask_user_question",
  );
  assert.ok(call?.kind === "tool_call");
  assert.deepEqual(publications, [
    {
      roomId: "actual-room",
      origin: { threadId: thread.id, callItemId: call.id },
      specification: { ...specification, answerTemplate: "scope: {{scope}}" },
    },
  ]);
  assert.deepEqual(call.content.arguments, {
    ...specification,
    roomId: "actual-room",
  });
  assert.deepEqual(snapshot.userQuestions, []);
  const summary = await host.readThreadSummary(thread.id);
  assert.equal(
    summary.status === "systemError"
      ? undefined
      : summary.userQuestionSummary?.openCount,
    0,
  );
  const result = snapshot.itemList!.find(
    (item) =>
      item.kind === "tool_result" &&
      item.content.callId === call.content.callId,
  );
  assert.ok(result?.kind === "tool_result");
  assert.match(result.content.text, /zen\.room-question\.published/);
  assert.match(result.content.text, /room-resource/);
  assert.doesNotMatch(result.content.text, /zen\.user-question\.published/);
  const tools = snapshot.itemList!.find((item) => item.kind === "tools");
  assert.ok(tools?.kind === "tools");
  assert.ok(
    Object.hasOwn(
      tools.content.tools.find((tool) => tool.name === "ask_user_question")!
        .inputSchema.properties ?? {},
      "roomId",
    ),
  );
});

test("omitted Room target retains Thread Ask and never invokes Room publisher", async (t) => {
  const host = await fixture(t, async () => {
    throw Error("Must not choose a Room implicitly");
  });
  const thread = await host.startThread();
  await (
    await host.startTurn(thread.id, ask())
  ).done;
  const questions = (await host.readThread(thread.id)).userQuestions!;
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.state, "open");
});

test("missing or failed Room service never falls back to a private Thread question", async (t) => {
  for (const publisher of [
    undefined,
    async () => {
      throw Error("Room membership changed");
    },
  ]) {
    const host = await fixture(t, publisher);
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, ask("actual-room"))
    ).done;
    const snapshot = await host.readThread(thread.id);
    assert.deepEqual(snapshot.userQuestions, []);
    const results = snapshot.itemList!.filter(
      (item) => item.kind === "tool_result",
    );
    assert.ok(
      results.some(
        (item) => item.kind === "tool_result" && item.content.exitCode !== 0,
      ),
    );
  }
});

test("authored origin fields and invalid Room targets are rejected before Room publication", async (t) => {
  let calls = 0;
  const host = await fixture(t, async (input) => {
    calls++;
    return { roomId: input.roomId, questionId: "resource", revision: 1 };
  });
  const thread = await host.startThread();
  for (const extra of [
    { roomId: "" },
    { roomId: " actual-room" },
    {
      roomId: "actual-room",
      origin: { threadId: "private", callItemId: "fake" },
    },
  ])
    await (
      await host.startTurn(
        thread.id,
        `!tool ask_user_question ${JSON.stringify({ ...specification, ...extra })}`,
      )
    ).done;
  assert.equal(calls, 0);
  assert.deepEqual((await host.readThread(thread.id)).userQuestions, []);
});

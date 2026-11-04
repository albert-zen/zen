import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import { FakeModel, type ModelRequest } from "../src/model.js";
import { ToolEnvironment } from "../src/tool.js";
import type { RoomUserQuestionPublicationReceipt } from "../src/user-question-tool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("real Host preserves Room Ask task receipts through completion, failure, cancellation and cold replay", async (t) => {
  for (const outcome of ["completed", "failed", "cancelled"] as const)
    await t.test(outcome, async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "question-room-scope-"),
      );
      const pending = deferred<RoomUserQuestionPublicationReceipt>();
      const receipt = {
        roomId: "fixture-room",
        questionId: "fixture-resource",
        revision: 1,
      };
      const requests: ModelRequest[] = [];
      const stream = FakeModel.prototype.stream;
      FakeModel.prototype.stream = async function* (request) {
        requests.push(request);
        yield* stream.call(this, request);
      };
      let aborted = false;
      const options = {
        cwd: root,
        dataDirectory: root,
        model: "fake",
        provider: { type: "fake" as const },
        approvalPolicy: "never" as const,
        toolPresentation: "direct" as const,
        publishRoomQuestion: async (_: unknown, signal: AbortSignal) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              pending.reject(new Error("fixture Room publication cancelled"));
            },
            { once: true },
          );
          return pending.promise;
        },
      };
      const makeHost = (yieldTimeMs = 1) =>
        createHostedAppServer({
          ...options,
          toolEnvironment: new ToolEnvironment({
            runtimes: [],
            taskOptions: { yieldTimeMs },
          }),
        });
      let host = makeHost();
      try {
        const thread = await host.startThread();
        await (
          await host.startTurn(
            thread.id,
            '!tool ask_user_question {"roomId":"fixture-room","questions":[{"prompt":"An independent Room question?"}]}',
          )
        ).done;
        const running = await host.readThread(thread.id);
        assert.deepEqual(running.userQuestions, []);
        const call = running.items.find(
          (item) =>
            item.type === "tool_call" && item.name === "ask_user_question",
        )!;
        assert.ok(call.type === "tool_call");
        const task = running.items.find(
          (item) => item.type === "tool_result" && item.callId === call.callId,
        )!;
        assert.ok(task.type === "tool_result");
        assert.equal(task.contentType, "application/vnd.zen.tool-task+json");
        assert.equal(
          (task.structuredContent as { status: string }).status,
          "running",
        );
        const binding = task.referenceBindings!.find(
          (entry) => entry.namespace === "builtin-task",
        )!;
        assert.equal(binding.ownerThreadId, thread.id);
        assert.deepEqual(binding.value, {
          taskId: (task.structuredContent as { task_id: string }).task_id,
          sourceToolCallId: call.id,
        });
        const semantic = running.itemList!.find(
          (item) =>
            item.kind === "tool_result" && item.content.callId === call.callId,
        )!;
        assert.ok(semantic.kind === "tool_result");
        assert.ok(
          requests.some((request) =>
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                message.callId === call.callId &&
                message.text === semantic.content.text,
            ),
          ),
          "real next ModelRequest must retain the legitimate running Task receipt",
        );
        assert.deepEqual(
          running.items.filter((item) => item.type === "failure"),
          [],
        );
        assert.ok(!semantic.content.text.includes('"questions":[{"id":"Q'));
        if (outcome === "completed") pending.resolve(receipt);
        else if (outcome === "failed")
          pending.reject(new Error("fixture Room publisher refused"));
        await (
          await host.startTurn(
            thread.id,
            `!tool wait ${JSON.stringify({ task_id: binding.ref, yield_time_ms: 100, ...(outcome === "cancelled" ? { terminate: true } : {}) })}`,
          )
        ).done;
        const final = await host.readThread(thread.id);
        assert.deepEqual(final.userQuestions, []);
        assert.deepEqual(
          final.items.filter((item) => item.type === "failure"),
          [],
        );
        const result = final.items
          .filter((item) => item.type === "tool_result")
          .at(-1)!;
        assert.ok(result.type === "tool_result");
        assert.equal(result.contentType, "application/vnd.zen.tool-task+json");
        if (outcome === "completed")
          assert.ok(
            result.output.includes(
              JSON.stringify({
                kind: "zen.room-question.published",
                version: 1,
                ...receipt,
              }),
            ),
          );
        else if (outcome === "failed")
          assert.match(result.output, /fixture Room publisher refused/u);
        else {
          assert.equal(aborted, true);
          assert.match(
            result.output,
            /tool task (cancelled|cancellation_unconfirmed)/u,
          );
        }
        const compiled = compileItemList(final.itemList!);
        for (const item of final.itemList!)
          if (item.kind === "tool_result")
            assert.ok(
              compiled.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.callId === item.content.callId &&
                  message.text === item.content.text,
              ),
            );
        const before = requests.length;
        await host.closeHostResources();
        host = makeHost(10_000);
        const cold = await host.readThread(thread.id);
        assert.deepEqual(cold.itemList, final.itemList);
        assert.deepEqual(compileItemList(cold.itemList!), compiled);
        await (
          await host.startTurn(
            thread.id,
            "Confirm the Room task history remains readable.",
          )
        ).done;
        assert.ok(requests.length > before);
        assert.deepEqual(
          (await host.readThread(thread.id)).items.filter(
            (item) => item.type === "failure",
          ),
          [],
        );
        await (
          await host.startTurn(
            thread.id,
            '!tool ask_user_question {"questions":[{"prompt":"First native question after Room task?"}]}',
          )
        ).done;
        const native = await host.readThread(thread.id);
        assert.equal(native.userQuestions!.length, 1);
        assert.ok(
          compileItemList(native.itemList!).messages.some(
            (message) =>
              message.role === "tool" &&
              message.text === 'Exit code: 0\n{"questions":[{"id":"Q1"}]}',
          ),
          "Room task history never allocates Thread numbers, including after cold replay",
        );
      } finally {
        pending.resolve(receipt);
        await host.closeHostResources();
        FakeModel.prototype.stream = stream;
        await rm(root, { recursive: true, force: true });
      }
    });
});

test("Room routing never exempts a recognized native Thread publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "question-room-guard-"));
  const host = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(
        thread.id,
        '!tool ask_user_question {"questions":[{"prompt":"Native Thread question?"}]}',
      )
    ).done;
    const snapshot = await host.readThread(thread.id);
    const items = structuredClone(snapshot.itemList!) as ContextItem[];
    const call = items.find(
      (item) =>
        item.kind === "tool_call" && item.content.name === "ask_user_question",
    )!;
    assert.ok(call.kind === "tool_call");
    call.content.arguments.roomId = "fixture-room";
    assert.throws(
      () => compileItemList(items),
      /Cannot safely display user question/u,
    );
    for (const roomId of [
      undefined,
      "",
      " fixture-room",
      "fixture-room\n",
      1,
    ]) {
      const bad = structuredClone(items);
      const candidate = bad.find((item) => item.id === call.id)!;
      const result = bad.find((item) => item.kind === "tool_result")!;
      assert.ok(
        candidate.kind === "tool_call" && result.kind === "tool_result",
      );
      if (roomId === undefined) delete candidate.content.arguments.roomId;
      else candidate.content.arguments.roomId = roomId;
      result.content.text = "Exit code: 0\n[tool task running]";
      assert.throws(
        () => compileItemList(bad),
        /Cannot safely display user question/u,
      );
    }
  } finally {
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

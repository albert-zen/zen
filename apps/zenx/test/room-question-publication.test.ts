import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { isHostCommand, isHostEvent } from "../src/main/host-messages.js";
import { createRoomQuestionPublisher } from "../src/main/room-question-publisher.js";
import type { RoomUserQuestionPublicationInput } from "../../../src/user-question-tool.js";

const specification = {
  questions: [{ id: "scope", prompt: "Synthetic Room workspace question" }],
  answerTemplate: "scope: {{scope}}",
};
const publication = {
  roomId: "actual-room",
  origin: { threadId: "member-a", callItemId: "runtime-call" },
  specification,
};

test("Room publication IPC rejects authored provenance overrides and mixed receipts", () => {
  assert.equal(
    isHostEvent({
      type: "room-question/publish-request",
      requestId: "r",
      input: publication,
    }),
    true,
  );
  assert.equal(
    isHostEvent({
      type: "room-question/publish-request",
      requestId: "r",
      input: { ...publication, threadId: "private" },
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "room-question/publish-request",
      requestId: "r",
      input: {
        ...publication,
        origin: { ...publication.origin, privateId: "forged" },
      },
    }),
    false,
  );
  assert.equal(
    isHostCommand({
      type: "room-question/publish-result",
      requestId: "r",
      result: { roomId: "actual-room", questionId: "resource", revision: 1 },
    }),
    true,
  );
  assert.equal(
    isHostCommand({
      type: "room-question/publish-result",
      requestId: "r",
      result: {},
      error: "unknown",
    }),
    false,
  );
  assert.equal(
    isHostCommand({
      type: "room-question/publish-result",
      requestId: "r",
      result: { roomId: "actual-room", questionId: "resource", revision: 0 },
    }),
    false,
  );
});

test("Room publication admission rejects unavailable origins and a replaced Room service", async () => {
  let available = true;
  let service: any = {
    publishRoomQuestion: async (
      _room: string,
      _origin: unknown,
      _specification: unknown,
      admit: () => Promise<void>,
    ) => {
      await admit();
      return { roomId: "actual-room", id: "resource", revision: 1 };
    },
  };
  const publisher = createRoomQuestionPublisher(
    {
      listThreadSummaries: async () =>
        available
          ? [{ threadId: "member-a", archived: false, status: "active" } as any]
          : [],
    },
    () => service,
  );
  assert.deepEqual(await publisher(publication, async () => {}), {
    roomId: "actual-room",
    questionId: "resource",
    revision: 1,
  });
  available = false;
  await assert.rejects(
    publisher(publication, async () => {}),
    /origin Thread is unavailable/,
  );
  available = true;
  await assert.rejects(
    publisher(publication, async () => {
      service = undefined;
    }),
    /service changed/,
  );
  await assert.rejects(
    publisher(publication, async () => {}),
    /service unavailable/,
  );
});

test("Room service replacement after publication returns unknown instead of an obsolete success receipt", async () => {
  const service = {
    publishRoomQuestion: async (
      _room: string,
      _origin: unknown,
      _specification: unknown,
      admit: () => Promise<void>,
    ) => {
      await admit();
      current = undefined;
      return { roomId: "actual-room", id: "possibly-committed", revision: 1 };
    },
  };
  let current: typeof service | undefined = service;
  const publisher = createRoomQuestionPublisher(
    {
      listThreadSummaries: async () => [
        { threadId: "member-a", archived: false, status: "active" } as any,
      ],
    },
    () => current,
  );
  await assert.rejects(
    publisher(publication, async () => {}),
    /may have committed.*do not replay/,
  );
});

test("real Desktop Host routes explicit Room Ask using actual model origin and never a Thread publication", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "room-question-host-"),
  );
  const config = {
    cwd: process.cwd(),
    dataDirectory: path.join(directory, "data"),
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never" as const,
    provider: { type: "fake" as const },
    toolPresentation: "direct" as const,
  };
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: config,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
  const publications: RoomUserQuestionPublicationInput[] = [];
  let allowed = true;
  // Keep one service identity across each admission fence, as production does.
  const service = {
    publishRoomQuestion: async (
      roomId: string,
      origin: typeof publication.origin,
      spec: unknown,
      admit: () => Promise<void>,
    ) => {
      await admit();
      if (!allowed) throw new Error("Room member removed");
      publications.push({
        roomId,
        origin,
        specification: spec as typeof specification,
      });
      return { roomId, id: `resource-${publications.length}`, revision: 1 };
    },
  };
  manager.setRoomQuestionPublisher(
    createRoomQuestionPublisher(manager, () => service),
  );
  try {
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const run = async (roomId?: string) => {
      const completed = new Promise<void>((resolve) => {
        const end = manager.onNotification((method) => {
          if (method === "turn/completed") {
            end();
            resolve();
          }
        });
      });
      await manager.request("turn/start", {
        threadId: thread.id,
        input: [
          {
            type: "text",
            text: `!tool ask_user_question ${JSON.stringify({ questions: specification.questions, ...(roomId ? { roomId } : {}) })}`,
          },
        ],
        clientUserMessageId: `synthetic-ask-${crypto.randomUUID()}`,
      });
      await completed;
      return (await manager.request("zen/thread/read", { threadId: thread.id }))
        .thread;
    };
    const roomSnapshot = await run("actual-room");
    assert.equal(publications.length, 1);
    const call = roomSnapshot.items.find(
      (item) => item.type === "tool_call" && item.name === "ask_user_question",
    );
    assert.ok(call?.type === "tool_call");
    assert.deepEqual(publications[0]!.origin, {
      threadId: thread.id,
      callItemId: call.id,
    });
    assert.equal(
      (
        (
          await manager.listThreadSummaries()
        )[0] as import("../../../src/thread-summary.js").ThreadSummary
      ).userQuestionSummary?.openCount,
      0,
    );
    const roomResults = roomSnapshot.items.filter(
      (item) => item.type === "tool_result",
    );
    assert.ok(
      roomResults.some(
        (item) =>
          item.type === "tool_result" &&
          item.output.includes("zen.room-question.published"),
      ),
    );
    allowed = false;
    await run("actual-room");
    assert.equal(
      publications.length,
      1,
      "removed membership cannot silently redirect publication",
    );
    assert.equal(
      (
        (
          await manager.listThreadSummaries()
        )[0] as import("../../../src/thread-summary.js").ThreadSummary
      ).userQuestionSummary?.openCount,
      0,
    );
    await run();
    assert.equal(publications.length, 1);
    const summary = (await manager.listThreadSummaries())[0]!;
    assert.equal(
      summary.status === "systemError"
        ? undefined
        : summary.userQuestionSummary?.openCount,
      1,
      "omitted target retains ordinary Thread behavior",
    );
    await manager.restart(config);
    assert.equal(
      publications.length,
      1,
      "restart never replays Room publication",
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real Desktop Host fences a delayed Room publication after interruption, replacement, or stop", async (t) => {
  for (const action of ["interrupt", "replace", "stop"] as const)
    await t.test(action, async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "room-question-host-fence-"),
      );
      const config = {
        cwd: process.cwd(),
        dataDirectory: path.join(directory, "data"),
        model: "fake",
        approvalPolicy: "never" as const,
        provider: { type: "fake" as const },
        toolPresentation: "direct" as const,
      };
      const manager = new AppServerManager({
        entryPath: path.resolve("src/main/app-server-host.ts"),
        tokenFile: path.join(directory, "runtime", "app-server.token"),
        hostConfig: config,
        execArgv: ["--import", "tsx"],
        startupTimeoutMs: 10000,
      });
      let release!: () => void, began!: () => void, settled!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          began = resolve;
        }),
        finished = new Promise<void>((resolve) => {
          settled = resolve;
        });
      let commits = 0,
        failure: unknown;
      manager.setRoomQuestionPublisher(async (input, admit) => {
        began();
        await gate;
        try {
          await admit();
          commits++;
          return {
            roomId: input.roomId,
            questionId: "must-not-commit",
            revision: 1,
          };
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          settled();
        }
      });
      try {
        await manager.start();
        const thread = (await manager.request("thread/start", {})).thread;
        const completed = new Promise<void>((resolve) => {
          const end = manager.onNotification((method) => {
            if (method === "turn/completed") {
              end();
              resolve();
            }
          });
        });
        const turn = (
          await manager.request("turn/start", {
            threadId: thread.id,
            input: [
              {
                type: "text",
                text: `!tool ask_user_question ${JSON.stringify({ questions: specification.questions, roomId: "actual-room" })}`,
              },
            ],
          })
        ).turn;
        await started;
        let stopping: Promise<void> | undefined;
        if (action === "interrupt")
          await manager.request("turn/interrupt", {
            threadId: thread.id,
            turnId: turn.id,
          });
        else if (action === "stop") stopping = manager.stop();
        else
          manager.setRoomQuestionPublisher(async () => {
            throw new Error("Replacement must not receive a replay");
          });
        release();
        await finished;
        if (stopping) await stopping;
        else await completed;
        assert.equal(commits, 0);
        assert.match(String(failure), /cancelled|Host changed|Host stopped/);
        if (action === "stop") return;
        const summary = (await manager.listThreadSummaries())[0]!;
        assert.equal(
          summary.status === "systemError"
            ? undefined
            : summary.userQuestionSummary?.openCount,
          0,
        );
      } finally {
        release();
        await manager.stop();
        await rm(directory, { recursive: true, force: true });
      }
    });
});

test("real Desktop model publishes into the Room journal, survives author removal and restart, and answers as a Room message", async () => {
  const { createBundledAutomationPluginService } =
    await import("../src/main/automation-plugin-service.js");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "room-question-real-journal-"),
  );
  const config = {
    cwd: process.cwd(),
    dataDirectory: path.join(directory, "threads"),
    model: "fake",
    approvalPolicy: "never" as const,
    provider: { type: "fake" as const },
    toolPresentation: "direct" as const,
  };
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: config,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
  let service:
    | Awaited<ReturnType<typeof createBundledAutomationPluginService>>
    | undefined;
  const open = async () => {
    service = await createBundledAutomationPluginService({
      userDataDirectory: path.join(directory, "product"),
      appServer: manager,
    });
    await service.startPlugin("zenx-rooms", {} as never);
  };
  manager.setRoomQuestionPublisher(
    createRoomQuestionPublisher(manager, () => service),
  );
  try {
    await manager.start();
    await open();
    const author = (await manager.request("thread/start", {})).thread;
    const peer = (await manager.request("thread/start", {})).thread;
    const room = await service!.createRoom({
      name: "Synthetic shared Room",
      members: [
        { threadId: author.id, name: "Author" },
        { threadId: peer.id, name: "Peer" },
      ],
    });
    const ask = async () => {
      const done = new Promise<void>((resolve) => {
        const end = manager.onNotification((method) => {
          if (method === "turn/completed") {
            end();
            resolve();
          }
        });
      });
      await manager.request("turn/start", {
        threadId: author.id,
        input: [
          {
            type: "text",
            text: `!tool ask_user_question ${JSON.stringify({ questions: specification.questions, roomId: room.id })}`,
          },
        ],
      });
      await done;
    };
    await ask();
    const published = (await service!.roomQuestions(room.id)).questions[0]!;
    assert.equal(published.origin.threadId, author.id);
    assert.equal(service!.roomQuestionSummary(room.id).openCount, 1);
    assert.equal(
      (await manager.listThreadSummaries()).find(
        (row) => row.threadId === author.id,
      )?.status,
      "idle",
    );
    const authorSnapshot = (
      await manager.request("zen/thread/read", { threadId: author.id })
    ).thread;
    assert.ok(
      authorSnapshot.items.some(
        (item) =>
          item.type === "tool_call" && item.id === published.origin.callItemId,
      ),
    );
    for (const summary of await manager.listThreadSummaries())
      assert.equal(
        summary.status === "systemError"
          ? undefined
          : summary.userQuestionSummary?.openCount,
        0,
      );
    await service!.removeRoomMember(room.id, author.id);
    await ask();
    assert.equal(
      service!.roomQuestionSummary(room.id).totalQuestions,
      1,
      "new calls from removed authors are denied",
    );
    assert.equal(
      (await service!.readRoomQuestion(room.id, published.id))!.state,
      "open",
      "removal never re-owns or deletes existing Room resource",
    );
    await service!.close();
    service = undefined;
    await manager.restart(config);
    await open();
    assert.deepEqual(
      (await service!.roomQuestions(room.id)).questions,
      [published],
      "restart reads Room journal instead of replaying original model call",
    );
    const receipt = await service!.respondRoomQuestion(
      {
        roomId: room.id,
        questionId: published.id,
        expectedRevision: published.revision,
        clientId: "stable-room-answer",
        outcome: "answer",
        answers: [
          {
            questionId: "scope",
            optionIds: [],
            text: "Synthetic Room-owned answer",
          },
        ],
      },
      async () => {},
    );
    assert.equal(receipt.response.status, "saved");
    assert.equal(receipt.question!.state, "answered");
    assert.ok(receipt.response.messageId);
    assert.ok(
      (
        await service!.readRoomMessage(room.id, receipt.response.messageId!)
      )?.message.text.includes("Synthetic Room-owned answer"),
    );
    const after = (
      await manager.request("zen/thread/read", { threadId: author.id })
    ).thread;
    assert.equal(
      after.items.some(
        (item) =>
          item.type === "user_message" && item.questionReply !== undefined,
      ),
      false,
      "Room answer is never fabricated as a private Thread question reply",
    );
    assert.equal(service!.roomQuestionSummary(room.id).openCount, 0);
  } finally {
    await service?.close();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

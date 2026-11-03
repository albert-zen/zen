import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { NativeQuestionListResult } from "../../../src/protocol/native/wire.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import {
  readZenXConnectionDescriptor,
  ZenXProtocolClient,
} from "../src/protocol-client/index.js";

const invalidationType = "thread-question/attention-invalidated";
const questionInput = `!tool ask_user_question ${JSON.stringify({
  questions: [
    {
      id: "scope",
      prompt:
        "Synthetic private scope that must not cross the invalidation IPC",
      options: [{ id: "small", label: "Small" }],
    },
  ],
})}`;

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function completeExternalTurn(
  client: ZenXProtocolClient,
  threadId: string,
  action: () => Promise<unknown>,
): Promise<void> {
  let completed = false;
  const dispose = client.onNotification("turn/completed", (event) => {
    if (event.threadId === threadId) {
      assert.equal(event.turn.status, "completed");
      completed = true;
    }
  });
  try {
    await action();
    await waitFor(() => completed, "external real Host turn completed");
  } finally {
    dispose();
  }
}

test(
  "an external first question discovers an untouched private Thread through content-free Desktop invalidations",
  { timeout: 45_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-unsubscribed-question-"),
    );
    const dataDirectory = path.join(directory, "data");
    const hostConfig = {
      cwd: directory,
      dataDirectory,
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never" as const,
      provider: { type: "fake" as const },
      toolPresentation: "direct" as const,
    };

    // Seed before Desktop connects. A new thread/started notification could
    // otherwise cause the real Desktop title handler to resume the target.
    const seed = createHostedAppServer(hostConfig);
    let threadId: string;
    try {
      threadId = (await seed.startThread()).id;
      assert.deepEqual((await seed.listUserQuestions(threadId)).questions, []);
    } finally {
      await seed.closeHostResources();
    }

    const entryPath = path.resolve("src/main/app-server-host.ts");
    const children: ChildProcess[] = [];
    const wireInvalidations: unknown[] = [];
    const emit = ChildProcess.prototype.emit;
    t.mock.method(
      ChildProcess.prototype,
      "emit",
      function (
        this: ChildProcess,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === "spawn" && this.spawnargs.includes(entryPath)) {
          children.push(this);
          this.on("message", (message: unknown) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === invalidationType
            )
              wireInvalidations.push(message);
          });
        }
        return Reflect.apply(emit, this, [event, ...args]);
      },
    );

    const descriptorFile = path.join(
      directory,
      "runtime",
      "zas-connection.json",
    );
    const manager = new AppServerManager({
      entryPath,
      tokenFile: path.join(directory, "runtime", "app-server.token"),
      descriptorFile,
      hostConfig,
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10_000,
    });
    let external: ZenXProtocolClient | undefined;
    let dispose: (() => void) | undefined;
    t.after(async () => {
      dispose?.();
      external?.close();
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const notifications: { method: string; params: unknown }[] = [];
    const recoveries: unknown[] = [];
    manager.onNotification((method, params) =>
      notifications.push({ method, params }),
    );
    manager.onThreadRecovery((recovery) => recoveries.push(recovery));
    const argumentsReceived: unknown[][] = [];
    const discoveries: { edge: number; summaries: NativeThreadSummary[] }[] =
      [];
    const readErrors: unknown[] = [];
    dispose = manager.onThreadQuestionAttentionInvalidated((...args) => {
      const edge = argumentsReceived.push(args);
      // Model the renderer's invalidation-driven summary read, never a manual
      // refresh, injected summary, or private Thread read/resume subscription.
      void manager.listThreadSummaries().then(
        (summaries) => discoveries.push({ edge, summaries }),
        (error: unknown) => readErrors.push(error),
      );
    });
    let removedListenerCalls = 0;
    manager.onThreadQuestionAttentionInvalidated(
      () => removedListenerCalls++,
    )();

    const openQuestionCount = (summaries: NativeThreadSummary[]) => {
      const summary = summaries.find((entry) => entry.threadId === threadId);
      return summary && summary.status !== "systemError"
        ? summary.userQuestionSummary?.openCount
        : undefined;
    };
    const connectExternal = async () => {
      const descriptor = await readZenXConnectionDescriptor(descriptorFile);
      return await ZenXProtocolClient.connect({
        url: descriptor.url,
        bearerTokenFile: descriptor.authentication.tokenFile,
        clientInfo: {
          name: "synthetic-external-question-publisher",
          title: "Synthetic external question publisher",
          version: "0.1.0",
        },
      });
    };
    const discoverAfter = async (priorEdge: number, openCount: number) => {
      await waitFor(
        () =>
          readErrors.length > 0 ||
          discoveries.some(
            ({ edge, summaries }) =>
              edge > priorEdge && openQuestionCount(summaries) === openCount,
          ),
        `a content-free manager edge discovers openCount ${openCount}`,
      );
      assert.deepEqual(readErrors, []);
      assert.ok(argumentsReceived.length > priorEdge);
      assert.ok(wireInvalidations.length >= argumentsReceived.length);
      assert.equal(removedListenerCalls, 0);
      for (const args of argumentsReceived) assert.deepEqual(args, []);
      for (const message of wireInvalidations)
        assert.deepEqual(message, { type: invalidationType });
      assert.deepEqual(
        notifications,
        [],
        "Desktop must receive neither native nor CAS private Thread content events",
      );
      assert.deepEqual(
        recoveries,
        [],
        "Desktop never subscribed to the Thread",
      );
    };

    await manager.start();
    const originalChild = children.at(-1);
    assert.ok(originalChild);
    assert.equal(originalChild.pid, manager.processId);
    assert.equal(openQuestionCount(await manager.listThreadSummaries()), 0);
    assert.equal(argumentsReceived.length, 0);
    external = await connectExternal();

    for (const outcome of ["answer", "cancel"] as const) {
      let priorEdge = argumentsReceived.length;
      await completeExternalTurn(external, threadId, () =>
        external!.request("turn/start", {
          threadId,
          input: [{ type: "text", text: questionInput }],
        }),
      );
      await discoverAfter(priorEdge, 1);
      const page: NativeQuestionListResult = await external.request(
        "zen/thread/questions/list",
        {
          threadId,
        },
      );
      assert.equal(page.totalPending, 1);
      const question = page.questions.find((entry) => entry.state === "open");
      assert.ok(
        question,
        "the actual external native read confirms publication",
      );
      priorEdge = argumentsReceived.length;
      const identity = {
        threadId,
        questionCallItemId: question.request.callItemId,
        clientUserMessageId: `synthetic-private-${outcome}`,
      };
      await completeExternalTurn(external, threadId, () =>
        external!.request(
          "zen/thread/questions/respond",
          outcome === "answer"
            ? {
                ...identity,
                outcome,
                answers: [{ questionId: "scope", optionIds: ["small"] }],
              }
            : { ...identity, outcome },
        ),
      );
      await discoverAfter(priorEdge, 0);
    }

    external.close();
    external = undefined;
    await manager.stop();
    const beforeStale = argumentsReceived.length;
    // Only lifecycle delivery is synthetic: a delayed message from the actual
    // retired child must not notify a stopped or replacement Desktop Host.
    originalChild.emit("message", { type: invalidationType });
    assert.equal(argumentsReceived.length, beforeStale);
    await manager.start();
    assert.notEqual(manager.processId, originalChild.pid);
    originalChild.emit("message", { type: invalidationType });
    assert.equal(argumentsReceived.length, beforeStale);

    external = await connectExternal();
    await completeExternalTurn(external, threadId, () =>
      external!.request("turn/start", {
        threadId,
        input: [{ type: "text", text: questionInput }],
      }),
    );
    await discoverAfter(beforeStale, 1);
  },
);

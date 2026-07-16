import { describe, expect, it } from "vitest";

import {
  AppServer,
  ApprovalBroker,
  PolicyToolRuntime,
  type AppServerNotification,
  type ModelGateway,
  type ToolRuntime
} from "./test-exports.js";

describe("approval resolution and interrupt ordering", () => {
  it("rejects a stale resolution when interrupt consumes the pending approval and continues FIFO", async () => {
    const broker = new ApprovalBroker({ generateId: () => "approval-1" });
    let shellStarts = 0;
    const server = createRaceServer({
      broker,
      toolRuntime: {
        async *execute() {
          shellStarts += 1;
          yield { type: "result.completed", content: "unexpected" };
        }
      }
    });
    const thread = await startThread(server);
    const approval = waitForApproval(server);
    const first = await startTurn(server, thread.id, "first");
    const second = await startTurn(server, thread.id, "second");
    const requested = await approval;

    const firstTerminal = waitForTerminal(server, thread.id, first.id);
    await server.request({ method: "turn/interrupt", params: { threadId: thread.id } });
    const stale = await server.request({
      method: "approval/resolve",
      params: {
        approvalId: requested.approvalId,
        threadId: requested.threadId,
        turnId: requested.turnId,
        decision: "approveOnce"
      }
    });

    expect(stale).toEqual(expect.objectContaining({ ok: false }));
    await firstTerminal;
    await waitForTerminal(server, thread.id, second.id);

    const snapshot = await readThread(server, thread.id);
    expect(shellStarts).toBe(0);
    expect(broker.listPending()).toEqual([]);
    expect(snapshot.turns.map((turn) => turn.status)).toEqual(["canceled", "completed"]);
    expect(snapshot.items.some((item) => item.type === "approval.resolved")).toBe(false);
  });

  it("allows an atomically consumed approval to start, then aborts it and continues FIFO", async () => {
    const broker = new ApprovalBroker({ generateId: () => "approval-1" });
    const shellStarted = deferred<void>();
    const shellAborted = deferred<void>();
    const server = createRaceServer({
      broker,
      toolRuntime: {
        async *execute(_call, context) {
          shellStarted.resolve();
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          shellAborted.resolve();
          yield { type: "error", error: new Error("shell aborted") };
        }
      }
    });
    const thread = await startThread(server);
    const approval = waitForApproval(server);
    const first = await startTurn(server, thread.id, "first");
    const second = await startTurn(server, thread.id, "second");
    const requested = await approval;

    const firstTerminal = waitForTerminal(server, thread.id, first.id);
    const approved = await server.request({
      method: "approval/resolve",
      params: {
        approvalId: requested.approvalId,
        threadId: requested.threadId,
        turnId: requested.turnId,
        decision: "approveOnce"
      }
    });
    expect(approved).toEqual(expect.objectContaining({ ok: true }));
    await shellStarted.promise;

    await server.request({ method: "turn/interrupt", params: { threadId: thread.id } });
    await shellAborted.promise;
    await firstTerminal;
    await waitForTerminal(server, thread.id, second.id);

    const snapshot = await readThread(server, thread.id);
    expect(broker.listPending()).toEqual([]);
    expect(snapshot.turns.map((turn) => turn.status)).toEqual(["canceled", "completed"]);
    expect(snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "approval.resolved",
        payload: expect.objectContaining({ decision: "approveOnce" })
      })
    ]));
  });
});

function createRaceServer(input: {
  readonly broker: ApprovalBroker;
  readonly toolRuntime: ToolRuntime;
}): AppServer {
  return new AppServer({
    approvalBroker: input.broker,
    threadManagerOptions: {
      generateThreadId: sequence("thread"),
      generateTurnId: sequence("turn"),
      generateRunId: sequence("run"),
      generateItemId: sequence("item"),
      runtimeFactory: ({ turn, approvalBroker }) => ({
        model: raceModel(turn.id === "turn-1"),
        toolRuntime: turn.id === "turn-1"
          ? new PolicyToolRuntime({
              approvalBroker: approvalBroker!,
              policy: { evaluate: () => ({ type: "needsApproval", reason: "shell approval" }) },
              toolRuntime: input.toolRuntime
            })
          : undefined
      })
    }
  });
}

function raceModel(needsShell: boolean): ModelGateway {
  let requestedShell = false;
  return {
    async *generate() {
      if (needsShell && !requestedShell) {
        requestedShell = true;
        yield {
          type: "message.completed",
          content: "running shell",
          toolCalls: [{ id: "shell-1", name: "shell", input: { command: "echo zen" } }]
        };
        return;
      }
      yield { type: "message.completed", content: "done" };
    }
  };
}

async function startThread(server: AppServer) {
  const response = await server.request({ method: "thread/start" });
  if (!response.ok || response.method !== "thread/start") throw new Error("thread did not start");
  return response.result.thread;
}

async function startTurn(server: AppServer, threadId: string, input: string) {
  const response = await server.request({ method: "turn/start", params: { threadId, input } });
  if (!response.ok || response.method !== "turn/start") throw new Error("turn did not start");
  return response.result.turn;
}

async function readThread(server: AppServer, threadId: string) {
  const response = await server.request({ method: "thread/read", params: { threadId } });
  if (!response.ok || response.method !== "thread/read") throw new Error("thread did not load");
  return response.result.thread;
}

function waitForApproval(server: AppServer): Promise<Extract<AppServerNotification, { readonly type: "approval/requested" }>> {
  return new Promise((resolve) => {
    const unsubscribe = server.subscribe((notification) => {
      if (notification.type === "approval/requested") {
        unsubscribe();
        resolve(notification);
      }
    });
  });
}

function waitForTerminal(server: AppServer, threadId: string, turnId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = server.subscribe((notification) => {
      if (
        (notification.type === "turn/completed" || notification.type === "turn/failed") &&
        notification.threadId === threadId &&
        notification.turn.id === turnId
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
}

function sequence(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

import { describe, expect, it } from "vitest";

import {
  AppServer,
  PolicyToolRuntime,
  type AppServerNotification,
  type ModelGateway
} from "../src/index.js";

describe("AppServer approval flow", () => {
  it("rejects a mismatched tuple, then records direct approval facts before a declined tool error", async () => {
    let executed = false;
    const requested = deferred<AppServerNotification>();
    const notifications: AppServerNotification[] = [];
    const model = approvalModel();
    const server = new AppServer({
      threadManagerOptions: {
        runtimeFactory: ({ approvalBroker }) => ({
          model,
          toolRuntime: new PolicyToolRuntime({
            approvalBroker: approvalBroker!,
            policy: { evaluate: () => ({ type: "needsApproval", reason: "shell requires approval" }) },
            toolRuntime: {
              async *execute() {
                executed = true;
                yield { type: "result.completed", content: "should not run" };
              }
            }
          })
        })
      }
    });
    server.subscribe((notification) => {
      notifications.push(notification);
      if (notification.type === "approval/requested") requested.resolve(notification);
    });

    const started = await server.request({ method: "thread/start" });
    if (!started.ok || started.method !== "thread/start") throw new Error("thread did not start");
    const turn = await server.request({ method: "turn/start", params: { threadId: started.result.thread.id, input: "run" } });
    if (!turn.ok || turn.method !== "turn/start") throw new Error("turn did not start");

    const pending = await requested.promise;
    if (pending.type !== "approval/requested") throw new Error("approval was not requested");
    const mismatch = await server.request({
      method: "approval/resolve",
      params: { approvalId: pending.approvalId, threadId: "wrong-thread", turnId: pending.turnId, decision: "decline" }
    });
    expect(mismatch).toEqual(expect.objectContaining({ ok: false }));

    const terminal = waitForTurnTerminal(server, pending.threadId, pending.turnId);
    const resolved = await server.request({
      method: "approval/resolve",
      params: { approvalId: pending.approvalId, threadId: pending.threadId, turnId: pending.turnId, decision: "decline" }
    });
    expect(resolved).toEqual(expect.objectContaining({ ok: true }));
    const duplicate = await server.request({
      method: "approval/resolve",
      params: { approvalId: pending.approvalId, threadId: pending.threadId, turnId: pending.turnId, decision: "decline" }
    });
    expect(duplicate).toEqual(expect.objectContaining({ ok: false }));

    await terminal;
    const thread = await server.request({ method: "thread/read", params: { threadId: pending.threadId } });
    if (!thread.ok || thread.method !== "thread/read") throw new Error("thread did not load");
    expect(executed).toBe(false);
    expect(thread.result.thread.items.map((item) => item.type)).toEqual(expect.arrayContaining([
      "approval.requested", "approval.resolved", "tool.error"
    ]));
    expect(notifications.map((event) => event.type)).toEqual(expect.arrayContaining([
      "approval/requested", "approval/resolved"
    ]));
  });
});

function approvalModel(): ModelGateway {
  let calls = 0;
  return {
    async *generate() {
      calls += 1;
      if (calls === 1) {
        yield { type: "message.completed", content: "calling", toolCalls: [{ id: "tool-1", name: "shell", input: { command: "echo blocked" } }] };
        return;
      }
      yield { type: "message.completed", content: "done" };
    }
  };
}

async function waitForTurnTerminal(server: AppServer, threadId: string, turnId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = server.subscribe((notification) => {
      if ((notification.type === "turn/completed" || notification.type === "turn/failed") && notification.threadId === threadId && notification.turn.id === turnId) {
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

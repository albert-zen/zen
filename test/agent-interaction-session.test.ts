import { describe, expect, it } from "vitest";

import {
  AgentInteractionSession,
  AppServer,
  createDemoAppServer,
  renderTerminalTranscript,
  type ModelGateway
} from "../src/index.js";

describe("AgentInteractionSession", () => {
  it("does not emit when a resumed snapshot is unchanged", async () => {
    const session = new AgentInteractionSession({
      client: createDemoAppServer({ appServerOptions: { threadManagerOptions: deterministicIds() } })
    });
    const started = await session.start();
    let calls = 0;
    session.observe(() => { calls += 1; });

    await session.resumeThread(started.thread?.id ?? "missing");

    expect(calls).toBe(0);
    session.dispose();
  });

  it("starts a thread and submits turns through an App Server client", async () => {
    const session = new AgentInteractionSession({
      client: createDemoAppServer({
        appServerOptions: { threadManagerOptions: deterministicIds() }
      })
    });

    const started = await session.start();
    expect(started.thread).toEqual(
      expect.objectContaining({ id: "thread-1", status: "idle" })
    );

    const submitted = await session.submit("hello from tui");

    expect(submitted.thread).toEqual(
      expect.objectContaining({ id: "thread-1", status: "idle" })
    );
    expect([...submitted.timelineRows]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "user", content: "hello from tui" }),
        expect.objectContaining({
          type: "assistant",
          content: "Zen demo response: hello from tui"
        })
      ])
    );

    session.dispose();
  });

  it("provides timeline rows usable by the terminal transcript renderer", async () => {
    const session = new AgentInteractionSession({
      client: createDemoAppServer({
        appServerOptions: { threadManagerOptions: deterministicIds() }
      })
    });

    await session.start();
    const submitted = await session.submit("use tool");
    const transcript = renderTerminalTranscript(submitted.timelineRows);

    expect(transcript).toEqual(
      expect.arrayContaining([
        "You: use tool",
        expect.stringContaining("Tool call demo.lookup"),
        expect.stringContaining("Tool result demo.lookup"),
        expect.stringContaining("Zen: Demo tool returned")
      ])
    );

    session.dispose();
  });

  it("lists saved threads with metadata derived from protocol snapshots", async () => {
    const session = new AgentInteractionSession({
      client: new AppServer({
        threadManagerOptions: {
          generateThreadId: sequence("thread"),
          generateRunId: sequence("run"),
          generateTurnId: sequence("turn"),
          generateItemId: sequence("item"),
          clock: tickingClock(1000, 100),
          runtimeFactory: () => ({
            model: {
              async *generate() {
                yield {
                  type: "message.completed",
                  content: "We added a resume picker summary"
                };
              }
            } satisfies ModelGateway
          })
        }
      })
    });

    await session.start();
    await session.submit("Find the previous picker work");

    await expect(session.listThreads()).resolves.toEqual([
      {
        id: "thread-1",
        status: "idle",
        turns: 1,
        items: 10,
        updatedAtMs: 1900,
        lastUserMessage: "Find the previous picker work",
        lastAssistantSummary: "We added a resume picker summary"
      }
    ]);
  });

  it("exposes the latest failed turn as recoverable session state", async () => {
    const session = new AgentInteractionSession({
      client: new AppServer({
        threadManagerOptions: {
          ...deterministicIds(),
          runtimeFactory: () => ({
            model: {
              async *generate() {
                yield { type: "error", error: new Error("model timed out") };
              }
            } satisfies ModelGateway
          })
        }
      })
    });

    await session.start();

    await expect(session.submit("retry this later")).rejects.toThrow(
      "model timed out"
    );

    expect(session.getSnapshot().recoverableTurn).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "failed",
      input: "retry this later",
      reason: "model timed out",
      retryAvailable: true
    });
  });
});

function deterministicIds() {
  return {
    generateThreadId: sequence("thread"),
    generateRunId: sequence("run"),
    generateTurnId: sequence("turn"),
    generateItemId: sequence("item"),
    clock: () => 1000
  };
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

function tickingClock(startMs: number, stepMs: number): () => number {
  let nextMs = startMs;

  return () => {
    const current = nextMs;
    nextMs += stepMs;
    return current;
  };
}

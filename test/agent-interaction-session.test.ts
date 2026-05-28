import { describe, expect, it } from "vitest";

import {
  AgentInteractionSession,
  createDemoAppServer,
  renderTerminalTranscript
} from "../src/index.js";

describe("AgentInteractionSession", () => {
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
    expect(submitted.timelineRows).toEqual(
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

import { describe, expect, it } from "vitest";

import {
  AppServer,
  createDemoAppServer,
  ZenTuiApp,
  type AppServerClient,
  type AppServerNotificationListener,
  type AppServerRequestInput,
  type AppServerResponse,
  type ModelGateway,
  type ThreadSnapshot
} from "../src/index.js";
import { VirtualTerminalDevice, waitForRender } from "./virtual-terminal.js";

describe("ZenTuiApp", () => {
  it("starts a session-backed terminal app and handles slash commands", async () => {
    const terminal = new VirtualTerminalDevice(100, 20);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    expect(terminal.textOutput()).toContain("Zen Agent");
    expect(terminal.textOutput()).toContain("thread-1");

    terminal.sendInput("/status");
    terminal.sendInput("\r");
    await waitForRender();

    expect(terminal.textOutput()).toContain("Notice: thread: thread-1");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("shows slash command suggestions while typing a command prefix", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("/");
    await waitForRender();

    expect(terminal.textOutput()).toContain("Commands");
    expect(terminal.textOutput()).toContain("/status");
    expect(terminal.textOutput()).toContain("/resume");

    terminal.clearOutput();
    terminal.sendInput("res");
    await waitForRender();

    const text = terminal.textOutput();
    expect(text).toContain("/resume [query|number|thread-id]");
    expect(text).not.toContain("/interrupt");

    terminal.sendInput("\u0003");
    await run;
  });

  it("uses the slash command registry for help output", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("/help");
    terminal.sendInput("\r");
    await waitForRender();

    expect(terminal.textOutput()).toContain("Notice: Commands");
    expect(terminal.textOutput()).toContain("/interrupt");
    expect(terminal.textOutput()).toContain("Cancel the active turn");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("streams demo turn rows into the rendered transcript", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("hello");
    terminal.sendInput("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const text = terminal.textOutput();
    expect(text).toContain("You");
    expect(text).toContain("hello");
    expect(text).toContain("Zen");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("does not expose protocol trace rows in the terminal transcript", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("hello");
    terminal.sendInput("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.textOutput()).not.toContain("assistant.message.started");
    expect(terminal.textOutput()).not.toContain("model.request.started");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("shows queued input while a turn is running", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createSlowAppServer(60),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("first");
    terminal.sendInput("\r");
    terminal.sendInput("second");
    terminal.sendInput("\r");
    await waitForRender();

    expect(terminal.textOutput()).toContain("queued 1");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("interrupts the active turn", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createSlowAppServer(1_000),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("slow");
    terminal.sendInput("\r");
    await waitForRender();
    terminal.sendInput("/interrupt");
    terminal.sendInput("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.textOutput()).toContain("Interrupted current turn");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("shows and accepts resume choices", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createDemoAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("/new");
    terminal.sendInput("\r");
    await waitForRender();
    terminal.sendInput("/resume");
    terminal.sendInput("\r");
    await waitForRender();

    expect(terminal.textOutput()).toContain("Resume");
    expect(terminal.textOutput()).toContain("/resume <number>");

    terminal.sendInput("/resume 1");
    terminal.sendInput("\r");
    await waitForRender();

    expect(terminal.textOutput()).toContain("Resumed");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("shows resume metadata and filters choices by query", async () => {
    const terminal = new VirtualTerminalDevice(120, 40);
    const app = new ZenTuiApp({
      client: new AppServer({
        threadManagerOptions: {
          initialThreads: [
            threadWithMessages({
              id: "parser-thread",
              user: "Fix parser bug",
              assistant: "Parser patch is ready",
              updatedAtMs: 1000
            }),
            threadWithMessages({
              id: "resume-thread",
              user: "Add resume picker",
              assistant: "Thread history search is ready",
              updatedAtMs: 2000
            })
          ]
        }
      }),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.clearOutput();
    terminal.sendInput("/resume picker");
    terminal.sendInput("\r");
    await waitForRender();

    const filtered = terminal.textOutput();
    expect(filtered).toContain("Resume");
    expect(filtered).toContain("1. resume-thread");
    expect(filtered).toContain("you: Add resume picker");
    expect(filtered).toContain("zen: Thread history search is ready");
    expect(filtered).not.toContain("2. parser-thread");

    terminal.clearOutput();
    terminal.sendInput("/resume 1");
    terminal.sendInput("\r");
    await waitForRender();

    const resumed = terminal.textOutput();
    expect(resumed).toContain("resume-thread | idle");
    expect(resumed).toContain("Resumed resume-thread");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("renders helpful resume notices for empty and failed listings", async () => {
    const emptyTerminal = new VirtualTerminalDevice(100, 30);
    const emptyApp = new ZenTuiApp({
      client: new ResumeListClient({
        listResponse: {
          method: "thread/list",
          ok: true,
          result: { threads: [] }
        }
      }),
      terminal: emptyTerminal
    });
    const emptyRun = emptyApp.run();

    await waitForRender();
    emptyTerminal.sendInput("/resume");
    emptyTerminal.sendInput("\r");
    await waitForRender();

    expect(emptyTerminal.textOutput()).toContain(
      "No saved threads found. Unreadable saved thread files are skipped."
    );

    emptyTerminal.sendInput("/exit");
    emptyTerminal.sendInput("\r");
    await emptyRun;

    const failedTerminal = new VirtualTerminalDevice(100, 30);
    const failedApp = new ZenTuiApp({
      client: new ResumeListClient({
        listResponse: {
          method: "thread/list",
          ok: false,
          error: {
            code: "REQUEST_FAILED",
            message: "Could not read saved thread history"
          }
        }
      }),
      terminal: failedTerminal
    });
    const failedRun = failedApp.run();

    await waitForRender();
    failedTerminal.sendInput("/resume");
    failedTerminal.sendInput("\r");
    await waitForRender();

    expect(failedTerminal.textOutput()).toContain(
      "Could not list saved threads: Could not read saved thread history"
    );

    failedTerminal.sendInput("/exit");
    failedTerminal.sendInput("\r");
    await failedRun;
  });
});

function createSlowAppServer(delayMs: number): AppServer {
  const model: ModelGateway = {
    async *generate(_context, _options, signal) {
      await delay(delayMs, signal);
      yield {
        type: "message.completed",
        content: "done"
      };
    }
  };

  return new AppServer({
    threadManagerOptions: {
      runtimeFactory: () => ({ model })
    }
  });
}

class ResumeListClient implements AppServerClient {
  private readonly thread: ThreadSnapshot = {
    id: "current-thread",
    status: "idle",
    turns: [],
    items: []
  };

  constructor(
    private readonly options: {
      readonly listResponse: AppServerResponse;
    }
  ) {}

  async request(request: AppServerRequestInput): Promise<AppServerResponse> {
    if (request.method === "thread/list") {
      return this.options.listResponse;
    }

    if (request.method === "thread/start") {
      return {
        method: "thread/start",
        ok: true,
        result: { thread: this.thread }
      };
    }

    if (request.method === "thread/read") {
      return {
        method: "thread/read",
        ok: true,
        result: { thread: this.thread }
      };
    }

    return {
      method: request.method,
      ok: false,
      error: {
        code: "UNKNOWN_METHOD",
        message: `Unknown method: ${request.method}`
      }
    };
  }

  subscribe(_listener: AppServerNotificationListener): () => void {
    return () => undefined;
  }
}

function threadWithMessages(options: {
  readonly id: string;
  readonly user: string;
  readonly assistant: string;
  readonly updatedAtMs: number;
}): ThreadSnapshot {
  const turnId = `${options.id}-turn`;
  const runId = `${options.id}-run`;

  return {
    id: options.id,
    status: "idle",
    turns: [
      {
        id: turnId,
        runId,
        status: "completed",
        itemIds: [`${options.id}-user`, `${options.id}-assistant`]
      }
    ],
    items: [
      {
        id: `${options.id}-user`,
        type: "user.message.completed",
        createdAtMs: options.updatedAtMs - 1,
        seq: 1,
        runId,
        turnId,
        payload: { content: options.user }
      },
      {
        id: `${options.id}-assistant`,
        type: "assistant.message.completed",
        createdAtMs: options.updatedAtMs,
        seq: 2,
        runId,
        turnId,
        payload: { content: options.assistant }
      }
    ]
  };
}

async function delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

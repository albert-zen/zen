import { describe, expect, it } from "vitest";

import { AppServer, createDemoAppServer, ZenTuiApp } from "../src/index.js";
import type { ModelGateway, ToolRuntime } from "../src/index.js";
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
    expect(text).toContain("/resume [number|thread-id]");
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

  it("renders collapsed shell rows while a command runs and completes", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createShellAppServer(),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("run tests");
    terminal.sendInput("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(terminal.textOutput()).toContain("Shell running: npm test");
    expect(terminal.textOutput()).toContain("stdout: started");

    terminal.clearOutput();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(terminal.textOutput()).toContain("Shell completed (exit 0): npm test");
    expect(terminal.textOutput()).toContain("stdout: started done");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });

  it("renders expanded shell output through the tools toggle", async () => {
    const terminal = new VirtualTerminalDevice(100, 30);
    const app = new ZenTuiApp({
      client: createShellAppServer({
        stderr: "warn\n"
      }),
      terminal
    });
    const run = app.run();

    await waitForRender();
    terminal.sendInput("run tests");
    terminal.sendInput("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    terminal.clearOutput();

    terminal.sendInput("/tools");
    terminal.sendInput("\r");
    await waitForRender();

    const text = terminal.textOutput();
    expect(text).toContain("Shell completed (exit 0)");
    expect(text).toContain("npm test");
    expect(text).toContain("stdout");
    expect(text).toContain("started");
    expect(text).toContain("done");
    expect(text).toContain("stderr");
    expect(text).toContain("warn");
    expect(text).not.toContain("toolCallId");
    expect(text).not.toContain('"content"');

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

function createShellAppServer(
  options: { readonly stderr?: string } = {}
): AppServer {
  let generatedToolCall = false;
  const model: ModelGateway = {
    async *generate() {
      if (!generatedToolCall) {
        generatedToolCall = true;
        yield {
          type: "message.completed",
          content: "Running tests.",
          toolCalls: [
            {
              id: "call-shell-1",
              name: "shell",
              input: { command: "npm test" }
            }
          ]
        };
        return;
      }

      yield {
        type: "message.completed",
        content: "Done."
      };
    }
  };
  const toolRuntime: ToolRuntime = {
    async *execute() {
      yield {
        type: "output.delta",
        delta: { stream: "stdout", chunk: "started\n" }
      };
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      yield {
        type: "output.delta",
        delta: { stream: "stdout", chunk: "done\n" }
      };
      if (options.stderr) {
        yield {
          type: "output.delta",
          delta: { stream: "stderr", chunk: options.stderr }
        };
      }
      yield {
        type: "result.completed",
        content: [
          "exitCode: 0",
          "stdout:",
          "started",
          "done",
          options.stderr ? `stderr:\n${options.stderr.trimEnd()}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      };
    }
  };

  return new AppServer({
    threadManagerOptions: {
      runtimeFactory: () => ({ model, toolRuntime })
    }
  });
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

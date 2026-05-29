import { describe, expect, it } from "vitest";

import { AppServer, createDemoAppServer, ZenTuiApp } from "../src/index.js";
import type { ModelGateway } from "../src/index.js";
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

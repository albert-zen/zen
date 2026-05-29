import { describe, expect, it } from "vitest";

import { createDemoAppServer, ZenTuiApp } from "../src/index.js";
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
    expect(text).toContain("You: hello");
    expect(text).toContain("Zen:");

    terminal.sendInput("/exit");
    terminal.sendInput("\r");
    await run;
  });
});

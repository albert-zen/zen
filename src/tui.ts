import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AgentInteractionSession } from "./agent-interaction-session.js";
import type { AppServerClient } from "./app-server.js";
import { createDemoAppServer } from "./demo-runtime.js";
import { createProviderBackedAppServer } from "./provider-runtime.js";
import { renderSlashCommandHelp } from "./slash-commands.js";
import {
  renderTerminalStatus,
  renderTerminalTranscript,
  renderThreadStarted
} from "./terminal-transcript.js";
import { ProcessTerminalDevice } from "./tui-engine.js";
import { ZenTuiApp } from "./zen-tui-app.js";

export type TuiOptions = {
  readonly client?: AppServerClient;
  readonly input?: Readable;
  readonly output?: Writable;
};

export async function runTui(options: TuiOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const client = options.client ?? (await createDefaultClient());

  if (isTty(input) && isTty(output)) {
    await new ZenTuiApp({
      client,
      terminal: new ProcessTerminalDevice(
        input as Readable & { setRawMode?: (mode: boolean) => void; isRaw?: boolean },
        output as Writable & { columns?: number; rows?: number }
      )
    }).run();
    return;
  }

  await runLineTui({ client, input, output });
}

async function runLineTui(options: Required<TuiOptions>): Promise<void> {
  const { input, output } = options;
  const session = new AgentInteractionSession({
    client: options.client
  });
  const unsubscribeRows = session.observe((event) => {
    if (event.type !== "rows") {
      return;
    }

    const printableRows = event.rows.filter(
      (row) => row.type !== "assistant-progress"
    );

    for (const renderedLine of renderTerminalTranscript(printableRows)) {
      writeLine(output, renderedLine);
    }
  });

  const rl = readline.createInterface({
    input,
    output,
    terminal: isTty(input) && isTty(output),
    prompt: "zen> "
  });
  let closed = false;

  rl.once("close", () => {
    closed = true;
  });

  try {
    const started = await session.start();
    const thread = started.thread;

    writeLine(output, "Zen Agent TUI");
    writeLine(output, "Type /help for commands.");
    if (thread) {
      writeLine(output, renderThreadStarted(thread));
    }
    promptIfOpen(rl, closed);

    for await (const rawLine of rl) {
      const line = rawLine.trim();

      if (line.length === 0) {
        promptIfOpen(rl, closed);
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        break;
      }

      if (line === "/help") {
        for (const renderedLine of renderSlashCommandHelp().split(/\r?\n/)) {
          writeLine(output, renderedLine);
        }
        promptIfOpen(rl, closed);
        continue;
      }

      if (line === "/status") {
        writeLine(output, renderTerminalStatus(session.getSnapshot().state));
        promptIfOpen(rl, closed);
        continue;
      }

      if (line === "/new") {
        const next = await session.newThread();
        if (next.thread) {
          writeLine(output, renderThreadStarted(next.thread));
        }
        promptIfOpen(rl, closed);
        continue;
      }

      try {
        await session.submit(line);
      } catch (cause) {
        writeLine(output, `Error: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      promptIfOpen(rl, closed);
    }
  } finally {
    unsubscribeRows();
    session.dispose();
    rl.close();
  }
}

function writeLine(output: Writable, line: string): void {
  output.write(`${line}\n`);
}

function promptIfOpen(rl: readline.Interface, closed: boolean): void {
  if (!closed) {
    rl.prompt();
  }
}

function isTty(stream: Readable | Writable): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

async function createDefaultClient(): Promise<AppServerClient> {
  if (process.env.ZEN_DEMO === "1") {
    return createDemoAppServer();
  }

  return await createProviderBackedAppServer({ cwd: process.cwd() });
}

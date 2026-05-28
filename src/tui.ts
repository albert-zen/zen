import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AgentInteractionSession } from "./agent-interaction-session.js";
import type { AppServerClient } from "./app-server.js";
import { createDemoAppServer } from "./demo-runtime.js";
import {
  renderTerminalStatus,
  renderTerminalTranscript,
  renderThreadStarted
} from "./terminal-transcript.js";

export type TuiOptions = {
  readonly client?: AppServerClient;
  readonly input?: Readable;
  readonly output?: Writable;
};

export async function runTui(options: TuiOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const session = new AgentInteractionSession({
    client: options.client ?? createDemoAppServer()
  });
  let printedRows = 0;

  const rl = readline.createInterface({
    input,
    output,
    terminal: isTty(input) && isTty(output),
    prompt: "zen> "
  });

  try {
    const started = await session.start();
    const thread = started.thread;

    writeLine(output, "Zen Agent TUI");
    writeLine(output, "Type /help for commands.");
    if (thread) {
      writeLine(output, renderThreadStarted(thread));
    }
    rl.prompt();

    for await (const rawLine of rl) {
      const line = rawLine.trim();

      if (line.length === 0) {
        rl.prompt();
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        break;
      }

      if (line === "/help") {
        writeLine(output, "Commands: /help, /status, /new, /exit");
        rl.prompt();
        continue;
      }

      if (line === "/status") {
        writeLine(output, renderTerminalStatus(session.getSnapshot().state));
        rl.prompt();
        continue;
      }

      if (line === "/new") {
        const next = await session.newThread();
        printedRows = 0;
        if (next.thread) {
          writeLine(output, renderThreadStarted(next.thread));
        }
        rl.prompt();
        continue;
      }

      const beforeCount = session.getSnapshot().timelineRows.length;
      const snapshot = await session.submit(line);
      const nextRows = snapshot.timelineRows.slice(Math.max(printedRows, beforeCount));
      const rendered = renderTerminalTranscript(nextRows);

      for (const renderedLine of rendered) {
        writeLine(output, renderedLine);
      }

      printedRows = snapshot.timelineRows.length;
      rl.prompt();
    }
  } finally {
    session.dispose();
    rl.close();
  }
}

function writeLine(output: Writable, line: string): void {
  output.write(`${line}\n`);
}

function isTty(stream: Readable | Writable): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

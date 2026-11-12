import readline from "node:readline";

import { CodexConnection } from "./connection.js";
import type { JsonRpcMessage } from "./wire.js";
import type { ZenAppServer } from "../../app-server.js";

export function serveCodexStdio(options: {
  appServer: ZenAppServer;
  zenHome: string;
}): () => void {
  const connection = new CodexConnection({
    ...options,
    send: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
  });
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  lines.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          id: null,
          error: { code: -32700, message: "Parse error" },
        })}\n`,
      );
      return;
    }
    void connection.receive(message);
  });
  lines.once("close", () => {
    connection.close("stdin closed");
  });

  return () => {
    lines.close();
    connection.close();
  };
}

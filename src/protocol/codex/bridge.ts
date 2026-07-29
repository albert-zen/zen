import { open } from "node:fs/promises";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import { WebSocket } from "ws";

export interface CodexStdioWebSocketBridgeOptions {
  url: string;
  bearerToken?: string;
  input?: Readable;
  output?: Writable;
}

/**
 * Carries Codex JSONL between a stdio-only client and a central Zen App Server.
 * The bridge deliberately does not parse messages or own protocol state.
 */
export async function bridgeCodexStdioToWebSocket(
  options: CodexStdioWebSocketBridgeOptions,
): Promise<void> {
  const socket = new WebSocket(options.url, {
    ...(options.bearerToken === undefined
      ? {}
      : { headers: { Authorization: `Bearer ${options.bearerToken}` } }),
  });
  await waitForOpen(socket);

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });

  await new Promise<void>((resolve, reject) => {
    let completed = false;
    let inputEnded = false;
    let terminalError: Error | undefined;

    const finish = (error?: Error): void => {
      if (completed) {
        return;
      }
      completed = true;
      lines.close();
      input.off("error", fail);
      output.off("error", fail);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const fail = (error: Error): void => {
      terminalError ??= error;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1011, "Bridge error");
      } else {
        finish(terminalError);
      }
    };

    input.once("error", fail);
    output.once("error", fail);
    lines.on("line", (line) => {
      if (socket.readyState !== WebSocket.OPEN) {
        fail(new Error("Central Zen App Server connection is not open"));
        return;
      }
      socket.send(line, (error) => {
        if (error !== null && error !== undefined) {
          fail(error);
        }
      });
    });
    lines.once("close", () => {
      inputEnded = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "stdin closed");
      } else if (socket.readyState === WebSocket.CLOSED) {
        finish(terminalError);
      }
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        terminalError = new Error(
          "Central Zen App Server sent a binary WebSocket frame",
        );
        socket.close(1003, "JSON text frames required");
        return;
      }
      output.write(`${data.toString()}\n`, (error) => {
        if (error !== null && error !== undefined) {
          fail(error);
        }
      });
    });
    socket.once("error", fail);
    socket.once("close", (code, reason) => {
      const error =
        terminalError ??
        (inputEnded || code === 1000 || code === 1001
          ? undefined
          : new Error(
              `Central Zen App Server connection closed (${String(code)}${
                reason.length === 0 ? "" : `: ${reason.toString()}`
              })`,
            ));
      finish(error);
    });
  });
}

export async function readBearerTokenFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Bearer token path is not a regular file: ${filePath}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o044) !== 0) {
      throw new Error(
        `Bearer token file is readable by group or others; run chmod 600 ${filePath}`,
      );
    }
    const token = (await handle.readFile("utf8")).trim();
    if (token.length === 0) {
      throw new Error(`Bearer token file is empty: ${filePath}`);
    }
    if (token.includes("\n") || token.includes("\r")) {
      throw new Error(`Bearer token file must contain exactly one token`);
    }
    return token;
  } finally {
    await handle.close();
  }
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const opened = (): void => {
      socket.off("error", failed);
      resolve();
    };
    const failed = (error: Error): void => {
      socket.off("open", opened);
      reject(error);
    };
    socket.once("open", opened);
    socket.once("error", failed);
  });
}

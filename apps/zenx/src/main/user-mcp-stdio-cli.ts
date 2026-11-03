#!/usr/bin/env node
import { runLiveHostUserMcpStdio } from "./user-mcp-stdio.js";

const args = process.argv.slice(2);
const allowed = new Set(["--descriptor", "--thread", "--room"]);
const values = new Map<string, string>();
try {
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (
      !allowed.has(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(
        "Usage: user-mcp-stdio --descriptor <existing-host-descriptor> --thread <thread-id> [--room <room-id>]",
      );
    values.set(key, value);
  }
  const descriptorFile = values.get("--descriptor");
  const threadId = values.get("--thread");
  const roomId = values.get("--room");
  if (!descriptorFile || !threadId)
    throw new Error(
      "Explicit --descriptor and --thread are required; this launcher never starts a Host",
    );
  const binding = await runLiveHostUserMcpStdio({
    descriptorFile,
    owner: roomId
      ? { kind: "room", roomId, threadId }
      : { kind: "thread", threadId },
  });
  process.once("SIGINT", () => void binding.close());
  process.once("SIGTERM", () => void binding.close());
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not connect to the existing Desktop Host",
  );
  process.exitCode = 1;
}

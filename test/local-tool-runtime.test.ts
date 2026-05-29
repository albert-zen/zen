import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LocalToolRuntime } from "../src/index.js";

describe("LocalToolRuntime", () => {
  it("reads, writes, lists, searches, and runs shell commands in the workspace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zen-tools-"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "note.txt"), "hello zen\n", "utf8");
    const runtime = new LocalToolRuntime({ cwd });

    await expect(runTool(runtime, "read_file", { path: "src/note.txt" })).resolves.toContain(
      "hello zen"
    );
    await expect(
      runTool(runtime, "write_file", { path: "src/out.txt", content: "written" })
    ).resolves.toBe("wrote src/out.txt");
    await expect(runTool(runtime, "list_files", { path: "src" })).resolves.toContain(
      "file note.txt"
    );
    await expect(
      runTool(runtime, "search_files", { pattern: "written", path: "src" })
    ).resolves.toContain("out.txt");
    await expect(runTool(runtime, "shell", { command: "Write-Output ok" })).resolves.toBe(
      "ok"
    );
  });
});

async function runTool(
  runtime: LocalToolRuntime,
  name: string,
  input: unknown
): Promise<unknown> {
  const events = [];

  for await (const event of runtime.execute(
    { id: `call-${name}`, name, input },
    {
      runId: "run-1",
      turnId: "turn-1",
      assistantItem: {
        id: "assistant-1",
        type: "assistant.message.completed",
        createdAtMs: 1000,
        seq: 1,
        runId: "run-1",
        turnId: "turn-1",
        payload: {}
      },
      startedItem: {
        id: "tool-1",
        type: "tool.call.started",
        createdAtMs: 1000,
        seq: 2,
        runId: "run-1",
        turnId: "turn-1",
        payload: {}
      }
    }
  )) {
    events.push(event);
  }

  const result = events.find((event) => event.type === "result.completed");

  if (!result || result.type !== "result.completed") {
    throw new Error("tool did not complete");
  }

  return result.content;
}

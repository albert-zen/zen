import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LocalToolRuntime, localToolDefinitions } from "../src/index.js";

describe("LocalToolRuntime", () => {
  it("exposes shell as the only local workspace tool", () => {
    expect(localToolDefinitions.map((definition) => definition.function.name)).toEqual([
      "shell"
    ]);
  });

  it("runs shell commands in the workspace and returns command output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zen-tools-"));
    const runtime = new LocalToolRuntime({ cwd });

    await expect(runTool(runtime, "shell", { command: "Write-Output ok" })).resolves.toBe(
      "exitCode: 0\nstdout:\nok"
    );
  });

  it("returns non-zero shell exits as normal tool results with stderr evidence", async () => {
    const runtime = new LocalToolRuntime({
      cwd: mkdtempSync(join(tmpdir(), "zen-tools-"))
    });

    await expect(
      runTool(runtime, "shell", {
        command: "Write-Error bad; exit 7"
      })
    ).resolves.toContain("exitCode: 7");
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

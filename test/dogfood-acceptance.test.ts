import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  runDogfoodAcceptanceScenario,
  summarizeDogfoodAcceptanceThread,
  AppServer,
  LocalToolRuntime,
  type ModelContext,
  type ProtocolItem,
  type ThreadSnapshot
} from "../src/index.js";

describe("dogfood acceptance scenario", () => {
  it("records a clear skip when OpenClaw credentials are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-dogfood-"));
    const evidencePath = join(root, "evidence.md");
    const fixtureRoot = join(root, "fixtures");
    const missingConfigPath = join(root, "missing-openclaw.json");

    const result = await runDogfoodAcceptanceScenario({
      configPath: missingConfigPath,
      evidencePath,
      fixtureRoot,
      now: () => new Date("2026-06-05T00:00:00.000Z")
    });

    expect(result.status).toBe("skipped");
    expect(result.fixturePath.startsWith(fixtureRoot)).toBe(true);
    expect(existsSync(join(result.fixturePath, "package.json"))).toBe(true);
    expect(await readdir(root)).toEqual(["evidence.md", "fixtures"]);

    const evidence = readFileSync(evidencePath, "utf8");

    expect(evidence).toContain("Status: skipped");
    expect(evidence).toContain(missingConfigPath);
    expect(evidence).toContain("Missing provider credentials are treated as a skip");
    expect(evidence).not.toContain("Status: passed");
  });

  it("requires shell inspect, edit, and test evidence before marking a thread passed", () => {
    const thread = createThread([
      item(1, "tool.call.started", {
        toolName: "shell",
        input: { command: "Get-ChildItem; Get-Content package.json" }
      }),
      item(2, "tool.result", {
        toolName: "shell",
        content: "exitCode: 0\nstdout:\npackage.json"
      }),
      item(3, "tool.call.started", {
        toolName: "shell",
        input: {
          command:
            "Set-Content -Path src/greeting.js -Value \"export function greet(name) { return `Hello, ${name}!`; }\""
        }
      }),
      item(4, "tool.result", {
        toolName: "shell",
        content: "exitCode: 0"
      }),
      item(5, "tool.call.started", {
        toolName: "shell",
        input: { command: "npm test" }
      }),
      item(6, "tool.result", {
        toolName: "shell",
        content: "exitCode: 0\nstdout:\ndogfood fixture passed"
      }),
      item(7, "assistant.message.completed", {
        content: "Updated greeting punctuation and verified npm test."
      })
    ]);

    expect(summarizeDogfoodAcceptanceThread(thread)).toEqual({
      status: "passed",
      finalAnswer: "Updated greeting punctuation and verified npm test.",
      shellCommands: [
        "Get-ChildItem; Get-Content package.json",
        "Set-Content -Path src/greeting.js -Value \"export function greet(name) { return `Hello, ${name}!`; }\"",
        "npm test"
      ],
      shellSteps: {
        inspect: true,
        edit: true,
        test: true
      },
      validationOutput: "exitCode: 0\nstdout:\ndogfood fixture passed"
    });
  });

  it("uses the test command result as validation output when later shell commands succeed", () => {
    const thread = createThread([
      item(1, "tool.call.started", {
        toolCallId: "call-inspect",
        toolName: "shell",
        input: { command: "Get-ChildItem; Get-Content package.json" }
      }),
      item(2, "tool.result.completed", {
        toolCallId: "call-inspect",
        toolName: "shell",
        content: "exitCode: 0\nstdout:\npackage.json"
      }),
      item(3, "tool.call.started", {
        toolCallId: "call-edit",
        toolName: "shell",
        input: {
          command:
            "Set-Content -Path src/greeting.js -Value \"export function greet(name) { return `Hello, ${name}!`; }\""
        }
      }),
      item(4, "tool.result.completed", {
        toolCallId: "call-edit",
        toolName: "shell",
        content: "exitCode: 0"
      }),
      item(5, "tool.call.started", {
        toolCallId: "call-test",
        toolName: "shell",
        input: { command: "npm test" }
      }),
      {
        ...item(6, "tool.result.completed", {
          toolCallId: "call-test",
          toolName: "shell",
          content: "exitCode: 1\nstderr:\nAssertionError: expected greeting punctuation"
        }),
        causeId: "item-5",
        targetId: "item-5"
      },
      item(7, "tool.call.started", {
        toolCallId: "call-later-edit",
        toolName: "shell",
        input: { command: "Set-Content -Path notes.txt -Value done" }
      }),
      item(8, "tool.result.completed", {
        toolCallId: "call-later-edit",
        toolName: "shell",
        content: "exitCode: 0"
      }),
      item(9, "assistant.message.completed", {
        content: "The edit was made but validation failed."
      })
    ]);

    expect(summarizeDogfoodAcceptanceThread(thread)).toEqual({
      status: "failed",
      finalAnswer: "The edit was made but validation failed.",
      shellCommands: [
        "Get-ChildItem; Get-Content package.json",
        "Set-Content -Path src/greeting.js -Value \"export function greet(name) { return `Hello, ${name}!`; }\"",
        "npm test",
        "Set-Content -Path notes.txt -Value done"
      ],
      shellSteps: {
        inspect: true,
        edit: true,
        test: true
      },
      validationOutput:
        "exitCode: 1\nstderr:\nAssertionError: expected greeting punctuation"
    });
  });

  it("runs a fixture task through the App Server transport and records passing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "zen-dogfood-"));
    const evidencePath = join(root, "evidence.md");
    const fixtureRoot = join(root, "fixtures");
    const configPath = join(root, "openclaw.json");
    writeOpenClawConfig(configPath);

    const result = await runDogfoodAcceptanceScenario({
      configPath,
      evidencePath,
      fixtureRoot,
      now: () => new Date("2026-06-05T00:00:00.000Z"),
      createAppServer: ({ fixturePath }) =>
        new AppServer({
          threadManagerOptions: {
            generateThreadId: sequence("thread"),
            generateRunId: sequence("run"),
            generateTurnId: sequence("turn"),
            generateItemId: sequence("item"),
            clock: () => 1000,
            runtimeFactory: () => ({
              model: createScriptedDogfoodModel(),
              toolRuntime: new LocalToolRuntime({ cwd: fixturePath })
            })
          }
        })
    });

    expect(result.status).toBe("passed");

    const evidence = readFileSync(evidencePath, "utf8");

    expect(evidence).toContain("Status: passed");
    expect(evidence).toContain("Get-ChildItem");
    expect(evidence).toContain("Set-Content");
    expect(evidence).toContain("npm test");
    expect(evidence).toContain("dogfood fixture passed");
    expect(readFileSync(join(result.fixturePath, "src", "greeting.js"), "utf8")).toContain(
      "Hello, ${name}!"
    );
  });
});

function createThread(items: readonly ProtocolItem[]): ThreadSnapshot {
  return {
    id: "thread-1",
    status: "idle",
    turns: [
      {
        id: "turn-1",
        runId: "run-1",
        status: "completed",
        itemIds: items.map((entry) => entry.id)
      }
    ],
    items
  };
}

function item(
  seq: number,
  type: string,
  payload: ProtocolItem["payload"]
): ProtocolItem {
  return {
    id: `item-${seq}`,
    type,
    createdAtMs: 1000 + seq,
    seq,
    runId: "run-1",
    turnId: "turn-1",
    payload
  };
}

function writeOpenClawConfig(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "Dogfood/test-model" }
        }
      },
      models: {
        providers: {
          Dogfood: {
            baseUrl: "https://example.test/v1",
            apiKey: "test-key",
            models: [{ id: "test-model", name: "Test model" }]
          }
        }
      }
    }),
    "utf8"
  );
}

function createScriptedDogfoodModel() {
  return {
    async *generate(context: ModelContext) {
      const shellResults = context.parts.filter((part) => part.type === "toolResult");

      if (shellResults.length === 0) {
        yield {
          type: "message.completed" as const,
          content: "Inspecting the fixture.",
          toolCalls: [
            {
              id: "call-inspect",
              name: "shell",
              input: { command: "Get-ChildItem; Get-Content package.json; Get-Content src/greeting.js" }
            }
          ]
        };
        return;
      }

      if (shellResults.length === 1) {
        yield {
          type: "message.completed" as const,
          content: "Updating the implementation.",
          toolCalls: [
            {
              id: "call-edit",
              name: "shell",
              input: {
                command:
                  "@'\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n'@ | Set-Content -Path src/greeting.js"
              }
            }
          ]
        };
        return;
      }

      if (shellResults.length === 2) {
        yield {
          type: "message.completed" as const,
          content: "Running validation.",
          toolCalls: [
            {
              id: "call-test",
              name: "shell",
              input: { command: "npm test" }
            }
          ]
        };
        return;
      }

      yield {
        type: "message.completed" as const,
        content: "Updated greeting punctuation and verified npm test."
      };
    }
  };
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

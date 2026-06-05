import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AppServerClient } from "./app-server.js";
import type {
  AppServerNotification,
  ProtocolItem,
  ThreadSnapshot
} from "./app-server-protocol.js";
import {
  HttpAppServerClient,
  serveAppServerHttpTransport
} from "./app-server-transport.js";
import { loadOpenClawModelConfig } from "./openclaw-config.js";
import { createOpenClawAppServer } from "./openclaw-runtime.js";
import { FileThreadStore } from "./thread-store.js";

export type DogfoodAcceptanceStatus = "passed" | "failed" | "skipped";

export type DogfoodAcceptanceSummary = {
  readonly status: Exclude<DogfoodAcceptanceStatus, "skipped">;
  readonly finalAnswer: string;
  readonly shellCommands: readonly string[];
  readonly shellSteps: {
    readonly inspect: boolean;
    readonly edit: boolean;
    readonly test: boolean;
  };
  readonly validationOutput: string;
};

export type DogfoodAcceptanceResult = {
  readonly status: DogfoodAcceptanceStatus;
  readonly evidencePath: string;
  readonly fixturePath: string;
  readonly reason?: string;
};

export type DogfoodAcceptanceOptions = {
  readonly configPath?: string;
  readonly evidencePath?: string;
  readonly fixtureRoot?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly createAppServer?: (input: {
    readonly fixturePath: string;
    readonly configPath?: string;
  }) => AppServerClient | Promise<AppServerClient>;
};

const DEFAULT_TIMEOUT_MS = 180_000;

export async function runDogfoodAcceptanceScenario(
  options: DogfoodAcceptanceOptions = {}
): Promise<DogfoodAcceptanceResult> {
  const now = options.now ?? (() => new Date());
  const fixtureRoot = options.fixtureRoot ?? join(tmpdir(), "zen-dogfood");
  const evidencePath =
    options.evidencePath ??
    join("docs", "implementation", "alb-94-dogfood-acceptance-transcript.md");
  const fixturePath = join(
    fixtureRoot,
    `fixture-${now().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`
  );

  await createFixtureWorkspace(fixturePath);

  const config = readConfigAvailability(options.configPath);

  if (!config.available) {
    await writeEvidence({
      status: "skipped",
      evidencePath,
      fixturePath,
      occurredAt: now(),
      reason: config.reason
    });

    return {
      status: "skipped",
      evidencePath,
      fixturePath,
      reason: config.reason
    };
  }

  return await executeDogfoodScenario({
    configPath: options.configPath,
    createAppServer: options.createAppServer,
    evidencePath,
    fixturePath,
    occurredAt: now(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
}

export function summarizeDogfoodAcceptanceThread(
  thread: ThreadSnapshot
): DogfoodAcceptanceSummary {
  const shellCalls = readShellCalls(thread.items);
  const shellCommands = shellCalls.map((call) => call.command);
  const shellSteps = {
    inspect: shellCommands.some(isInspectCommand),
    edit: shellCommands.some(isEditCommand),
    test: shellCommands.some(isTestCommand)
  };
  const validationOutput = readValidationOutput(thread.items, shellCalls);
  const finalAnswer = readFinalAnswer(thread.items);
  const latestTurn = thread.turns.at(-1);
  const passed =
    thread.status === "idle" &&
    latestTurn?.status === "completed" &&
    shellSteps.inspect &&
    shellSteps.edit &&
    shellSteps.test &&
    validationOutput.includes("exitCode: 0");

  return {
    status: passed ? "passed" : "failed",
    finalAnswer,
    shellCommands,
    shellSteps,
    validationOutput
  };
}

async function createFixtureWorkspace(fixturePath: string): Promise<void> {
  await mkdir(join(fixturePath, "src"), { recursive: true });
  await mkdir(join(fixturePath, "test"), { recursive: true });
  await writeFile(
    join(fixturePath, "package.json"),
    `${JSON.stringify(
      {
        name: "zen-dogfood-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: { test: "node test/greeting.test.js" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(fixturePath, "src", "greeting.js"),
    "export function greet(name) {\n  return `Hello, ${name}.`;\n}\n",
    "utf8"
  );
  await writeFile(
    join(fixturePath, "test", "greeting.test.js"),
    "import { strict as assert } from 'node:assert';\nimport { greet } from '../src/greeting.js';\n\nassert.equal(greet('Zen'), 'Hello, Zen!');\nconsole.log('dogfood fixture passed');\n",
    "utf8"
  );
}

function readConfigAvailability(
  configPath: string | undefined
): { readonly available: true } | { readonly available: false; readonly reason: string } {
  try {
    loadOpenClawModelConfig(configPath ? { path: configPath } : {});
    return { available: true };
  } catch (cause) {
    return {
      available: false,
      reason: `OpenClaw config unavailable${configPath ? ` at ${configPath}` : ""}: ${readErrorMessage(cause)}`
    };
  }
}

async function writeEvidence(input: {
  readonly status: DogfoodAcceptanceStatus;
  readonly evidencePath: string;
  readonly fixturePath: string;
  readonly occurredAt: Date;
  readonly reason: string;
  readonly summary?: DogfoodAcceptanceSummary;
  readonly notifications?: readonly AppServerNotification[];
}): Promise<void> {
  await mkdir(dirname(input.evidencePath), { recursive: true });
  const summaryLines = input.summary
    ? [
        "",
        "## Shell Evidence",
        "",
        `Inspect shell used: ${input.summary.shellSteps.inspect ? "yes" : "no"}`,
        `Edit shell used: ${input.summary.shellSteps.edit ? "yes" : "no"}`,
        `Test shell used: ${input.summary.shellSteps.test ? "yes" : "no"}`,
        "",
        "### Commands",
        "",
        ...input.summary.shellCommands.map((command) => `- \`${command}\``),
        "",
        "### Validation Output",
        "",
        "```text",
        input.summary.validationOutput,
        "```",
        "",
        "### Final Answer",
        "",
        input.summary.finalAnswer
      ]
    : [];
  const notificationLines = input.notifications?.length
    ? [
        "",
        "## Protocol Notifications",
        "",
        "```json",
        JSON.stringify(input.notifications, null, 2),
        "```"
      ]
    : [];

  await writeFile(
    input.evidencePath,
    [
      "# ALB-94 Dogfood Coding-Agent Acceptance Transcript",
      "",
      `Status: ${input.status}`,
      `Recorded at: ${input.occurredAt.toISOString()}`,
      `Fixture workspace: ${input.fixturePath}`,
      "",
      "## Result",
      "",
      input.reason,
      "",
      readEvidenceStatusLine(input.status),
      ...summaryLines,
      ...notificationLines,
      ""
    ].join("\n"),
    "utf8"
  );
}

function readEvidenceStatusLine(status: DogfoodAcceptanceStatus): string {
  if (status === "skipped") {
    return "Missing provider credentials are treated as a skip, not a false pass.";
  }

  if (status === "passed") {
    return "The scenario passed with reviewable shell and validation evidence.";
  }

  return "The scenario did not pass.";
}

async function executeDogfoodScenario(input: {
  readonly configPath?: string;
  readonly createAppServer?: DogfoodAcceptanceOptions["createAppServer"];
  readonly evidencePath: string;
  readonly fixturePath: string;
  readonly occurredAt: Date;
  readonly timeoutMs: number;
}): Promise<DogfoodAcceptanceResult> {
  const notifications: AppServerNotification[] = [];
  let transport: Awaited<ReturnType<typeof serveAppServerHttpTransport>> | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    const appServer = await createScenarioAppServer(input);
    transport = await serveAppServerHttpTransport({
      appServer,
      host: "127.0.0.1",
      port: 0
    });
    const client = new HttpAppServerClient({ baseUrl: transport.url });
    unsubscribe = client.subscribe((notification) => {
      notifications.push(notification);
    });

    const start = await client.request({ method: "thread/start" });

    if (!start.ok || start.method !== "thread/start") {
      throw new Error("Dogfood thread/start failed");
    }

    await client.request({
      method: "turn/start",
      params: {
        threadId: start.result.thread.id,
        input: createDogfoodPrompt()
      }
    });
    await waitForTurnTerminalNotification(
      notifications,
      start.result.thread.id,
      input.timeoutMs
    );

    const read = await client.request({
      method: "thread/read",
      params: { threadId: start.result.thread.id }
    });

    if (!read.ok || read.method !== "thread/read") {
      throw new Error("Dogfood thread/read failed");
    }

    const summary = summarizeDogfoodAcceptanceThread(read.result.thread);
    const reason =
      summary.status === "passed"
        ? "The model completed the fixture task with shell inspect, edit, and test evidence."
        : "The captured thread did not satisfy all dogfood shell evidence requirements.";

    await writeEvidence({
      status: summary.status,
      evidencePath: input.evidencePath,
      fixturePath: input.fixturePath,
      occurredAt: input.occurredAt,
      reason,
      summary,
      notifications
    });

    return {
      status: summary.status,
      evidencePath: input.evidencePath,
      fixturePath: input.fixturePath,
      reason
    };
  } catch (cause) {
    const message = readErrorMessage(cause);
    const status: DogfoodAcceptanceStatus = isProviderUnavailableMessage(message)
      ? "skipped"
      : "failed";
    const reason =
      status === "skipped"
        ? `Provider or network credentials unavailable: ${message}`
        : `Dogfood scenario failed: ${message}`;

    await writeEvidence({
      status,
      evidencePath: input.evidencePath,
      fixturePath: input.fixturePath,
      occurredAt: input.occurredAt,
      reason,
      notifications
    });

    return {
      status,
      evidencePath: input.evidencePath,
      fixturePath: input.fixturePath,
      reason
    };
  } finally {
    unsubscribe?.();
    await transport?.close();
  }
}

async function createScenarioAppServer(input: {
  readonly configPath?: string;
  readonly fixturePath: string;
  readonly createAppServer?: DogfoodAcceptanceOptions["createAppServer"];
}): Promise<AppServerClient> {
  if (input.createAppServer) {
    return await input.createAppServer({
      fixturePath: input.fixturePath,
      configPath: input.configPath
    });
  }

  return await createOpenClawAppServer({
    cwd: input.fixturePath,
    config: input.configPath ? { path: input.configPath } : undefined,
    threadStore: new FileThreadStore({
      dir: join(input.fixturePath, ".zen", "threads")
    })
  });
}

function createDogfoodPrompt(): string {
  return [
    "You are running Zen's ALB-94 dogfood acceptance scenario in a temporary fixture repo.",
    "Use the shell tool for every workspace fact.",
    "Task:",
    "1. Inspect the fixture files before deciding what to edit.",
    "2. Fix the implementation so the existing test passes.",
    "3. Run npm test.",
    "4. Reply with a concise summary of the edit and validation.",
    "Stay inside the current working directory. Do not read or write parent directories."
  ].join("\n");
}

async function waitForTurnTerminalNotification(
  notifications: readonly AppServerNotification[],
  threadId: string,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (
      notifications.some(
        (notification) =>
          "threadId" in notification &&
          notification.threadId === threadId &&
          (notification.type === "turn/completed" ||
            notification.type === "turn/failed")
      )
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Dogfood turn did not finish within ${timeoutMs}ms`);
}

function isProviderUnavailableMessage(message: string): boolean {
  return /OpenClaw config unavailable|Model request failed: (401|403)|fetch failed|ENOTFOUND|ECONN|UND_ERR|network|credential/i.test(
    message
  );
}

type ShellCallEvidence = {
  readonly command: string;
  readonly startedId: string;
  readonly startedIndex: number;
  readonly toolCallId?: string;
};

function readShellCalls(items: readonly ProtocolItem[]): readonly ShellCallEvidence[] {
  return items.flatMap((item, startedIndex): readonly ShellCallEvidence[] => {
    if (item.type !== "tool.call.started" || !isRecord(item.payload)) {
      return [];
    }

    if (item.payload.toolName !== "shell" || !isRecord(item.payload.input)) {
      return [];
    }

    const command = item.payload.input.command;

    if (typeof command !== "string") {
      return [];
    }

    return [
      {
        command,
        startedId: item.id,
        startedIndex,
        toolCallId: readString(item.payload.toolCallId)
      }
    ];
  });
}

function readValidationOutput(
  items: readonly ProtocolItem[],
  shellCalls: readonly ShellCallEvidence[]
): string {
  let latestTestOutput = "";

  for (const call of shellCalls) {
    if (!isTestCommand(call.command)) {
      continue;
    }

    const output = readShellResultForCall(items, shellCalls, call);

    if (output !== undefined) {
      latestTestOutput = output;
    }
  }

  return latestTestOutput;
}

function readShellResultForCall(
  items: readonly ProtocolItem[],
  shellCalls: readonly ShellCallEvidence[],
  call: ShellCallEvidence
): string | undefined {
  const nextCall = shellCalls.find(
    (candidate) => candidate.startedIndex > call.startedIndex
  );
  const endIndex = nextCall?.startedIndex ?? items.length;

  for (
    let index = call.startedIndex + 1;
    index < endIndex;
    index += 1
  ) {
    const result = readShellResult(items[index]);

    if (!result) {
      continue;
    }

    if (isResultLinkedToCall(result.item, result.payload, call)) {
      return result.content;
    }
  }

  return undefined;
}

function readShellResult(item: ProtocolItem | undefined):
  | {
      readonly item: ProtocolItem;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly content: string;
    }
  | undefined {
  if (
    !item ||
    (item.type !== "tool.result.completed" && item.type !== "tool.result") ||
    !isRecord(item.payload) ||
    item.payload.toolName !== "shell" ||
    typeof item.payload.content !== "string"
  ) {
    return undefined;
  }

  return {
    item,
    payload: item.payload,
    content: item.payload.content
  };
}

function isResultLinkedToCall(
  item: ProtocolItem,
  payload: Readonly<Record<string, unknown>>,
  call: ShellCallEvidence
): boolean {
  const resultToolCallId = readString(payload.toolCallId);
  const hasExplicitLink =
    resultToolCallId !== undefined ||
    item.targetId !== undefined ||
    item.causeId !== undefined;

  if (!hasExplicitLink) {
    return true;
  }

  return (
    (resultToolCallId !== undefined &&
      call.toolCallId !== undefined &&
      resultToolCallId === call.toolCallId) ||
    item.targetId === call.startedId ||
    item.causeId === call.startedId
  );
}

function readFinalAnswer(items: readonly ProtocolItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (
      item?.type === "assistant.message.completed" &&
      isRecord(item.payload) &&
      typeof item.payload.content === "string"
    ) {
      return item.payload.content;
    }
  }

  return "";
}

function isInspectCommand(command: string): boolean {
  return /\b(Get-ChildItem|Get-Content|rg|dir|ls|type)\b/i.test(command);
}

function isEditCommand(command: string): boolean {
  return /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b/i.test(
    command
  );
}

function isTestCommand(command: string): boolean {
  return /\b(npm\s+(run\s+)?test|npm\s+test|node\s+test\/)/i.test(command);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

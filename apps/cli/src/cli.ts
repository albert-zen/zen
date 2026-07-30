#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";

import { createHostedAppServer, type HostProvider } from "./host.js";
import { OpenAiSubscriptionAuthProfile } from "./subscription-auth.js";
import { DEFAULT_OPENAI_SUBSCRIPTION_MODEL } from "../../../src/model/openai-subscription.js";
import {
  CodexClient,
  responseResult,
} from "../../../src/protocol/codex/client.js";
import {
  bridgeCodexStdioToWebSocket,
  readBearerTokenFile,
} from "../../../src/protocol/codex/bridge.js";
import { serveCodexStdio } from "../../../src/protocol/codex/stdio.js";
import {
  serveCodexWebSocket,
  type CodexWebSocketServer,
} from "../../../src/protocol/codex/websocket.js";
import { isRecord } from "../../../src/protocol/codex/wire.js";

interface ParsedArguments {
  options: Map<string, string | true>;
  positionals: string[];
}

interface ClientSession {
  client: CodexClient;
  localServer?: CodexWebSocketServer;
}

const DEFAULT_APPROVAL_POLICY = "never" as const;

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "app-server") {
    await appServerCommand(parseAppServerArguments(args));
  } else if (command === "run") {
    await runCommand(parseArguments(args));
  } else if (command === "chat") {
    await chatCommand(parseArguments(args));
  } else if (command === "threads") {
    await threadsCommand(parseArguments(args));
  } else if (command === "auth") {
    await authCommand(parseArguments(args));
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

async function appServerCommand(args: ParsedArguments): Promise<void> {
  assertNoPositionals(args);
  const remote = option(args, "remote");
  if (remote !== undefined && args.options.has("listen")) {
    throw new Error("--remote and --listen cannot be used together");
  }
  const bearerToken = await loadBearerToken(args);
  if (remote !== undefined) {
    await bridgeCodexStdioToWebSocket({
      url: remote,
      ...(bearerToken === undefined ? {} : { bearerToken }),
    });
    return;
  }

  const listen = option(args, "listen") ?? "ws://127.0.0.1:4500";
  const zenHome = dataDirectory(args);
  const hostConfig = hostOptions(args);
  const host = createHostedAppServer(hostConfig);
  if (listen === "stdio://" || listen === "stdio") {
    if (bearerToken !== undefined) {
      throw new Error(
        "--auth-token-file only applies to WebSocket listeners or --remote",
      );
    }
    serveCodexStdio({
      appServer: host,
      zenHome,
      configuredModel: hostConfig.model,
    });
    return;
  }

  const server = await serveCodexWebSocket({
    appServer: host,
    zenHome,
    listen,
    configuredModel: hostConfig.model,
    ...(bearerToken === undefined ? {} : { bearerToken }),
  });
  process.stderr.write(`Zen App Server listening on ${server.url}\n`);
  await waitForShutdown(server);
}

async function runCommand(args: ParsedArguments): Promise<void> {
  if (args.positionals.length === 0) {
    throw new Error("zen run requires a prompt");
  }
  const session = await connectClient(args);
  try {
    const decision = flag(args, "approve") ? "accept" : "decline";
    session.client.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => ({ decision }),
    );
    const threadId = await openThread(
      session.client,
      args,
      session.localServer !== undefined,
    );
    await runOneTurn(session.client, threadId, args.positionals.join(" "));
  } finally {
    session.client.close();
    await session.localServer?.close();
  }
}

async function chatCommand(args: ParsedArguments): Promise<void> {
  assertNoPositionals(args);
  const session = await connectClient(args);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    session.client.onServerRequest(
      "item/commandExecution/requestApproval",
      async (params) => {
        const command =
          isRecord(params) && typeof params.command === "string"
            ? params.command
            : "(unknown command)";
        const answer = (
          await terminal.question(
            `\nApprove command ${JSON.stringify(command)}? [y]es/[a]ll session/[n]o/[c]ancel: `,
          )
        )
          .trim()
          .toLowerCase();
        const decision =
          answer === "y" || answer === "yes"
            ? "accept"
            : answer === "a" || answer === "all"
              ? "acceptForSession"
              : answer === "c" || answer === "cancel"
                ? "cancel"
                : "decline";
        return { decision };
      },
    );

    const threadId = await openThread(
      session.client,
      args,
      session.localServer !== undefined,
    );
    process.stdout.write(`Zen thread ${threadId}. Type /exit to stop.\n`);
    while (true) {
      const prompt = (await terminal.question("> ")).trim();
      if (prompt === "/exit" || prompt === "/quit") {
        break;
      }
      if (prompt.length === 0) {
        continue;
      }
      await runOneTurn(session.client, threadId, prompt);
    }
  } finally {
    terminal.close();
    session.client.close();
    await session.localServer?.close();
  }
}

async function threadsCommand(args: ParsedArguments): Promise<void> {
  assertNoPositionals(args);
  const session = await connectClient(args);
  try {
    const response = await session.client.request("thread/list", {});
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new Error("App Server returned an invalid thread list");
    }
    for (const value of response.data) {
      if (!isRecord(value)) {
        continue;
      }
      const status =
        isRecord(value.status) && typeof value.status.type === "string"
          ? value.status.type
          : "unknown";
      process.stdout.write(
        `${String(value.id)}\t${status}\t${String(value.preview ?? "")}\n`,
      );
    }
  } finally {
    session.client.close();
    await session.localServer?.close();
  }
}

async function authCommand(args: ParsedArguments): Promise<void> {
  const [action, ...extra] = args.positionals;
  if (action === undefined || extra.length > 0) {
    throw new Error("Usage: zen auth login|status|logout");
  }
  const profile = new OpenAiSubscriptionAuthProfile(
    subscriptionProfilePath(args),
  );

  if (action === "status") {
    const status = await profile.status();
    if (!status.authenticated) {
      process.stdout.write("OpenAI subscription: not authenticated\n");
      return;
    }
    const expiration =
      status.expiresAt === undefined
        ? ""
        : `, expires ${new Date(status.expiresAt).toISOString()}`;
    const account =
      status.accountId === undefined ? "" : ` (${status.accountId})`;
    process.stdout.write(
      `OpenAI subscription: ${status.expired ? "expired" : "authenticated"}${account}${expiration}\n`,
    );
    return;
  }

  if (action === "logout") {
    await profile.logout();
    process.stdout.write("OpenAI subscription: logged out\n");
    return;
  }

  if (action !== "login") {
    throw new Error(`Unknown auth action: ${action}`);
  }

  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await profile.login({
      notifyAuthUrl: (url) => {
        process.stdout.write(`Open this URL to sign in:\n${url}\n`);
        openBrowser(url);
      },
      readManualCode: async ({ message, signal }) =>
        await terminal.question(`${message} `, { signal }),
    });
    process.stdout.write("OpenAI subscription: authenticated\n");
  } finally {
    terminal.close();
  }
}

async function connectClient(args: ParsedArguments): Promise<ClientSession> {
  let localServer: CodexWebSocketServer | undefined;
  const remote = option(args, "remote");
  if (remote !== undefined && args.options.has("listen")) {
    throw new Error("--remote and --listen cannot be used together");
  }
  const bearerToken = await loadBearerToken(args);
  let url = remote;
  if (remote === undefined) {
    const hostConfig = hostOptions(args);
    localServer = await serveCodexWebSocket({
      appServer: createHostedAppServer(hostConfig),
      zenHome: dataDirectory(args),
      listen: "ws://127.0.0.1:0",
      configuredModel: hostConfig.model,
      ...(bearerToken === undefined ? {} : { bearerToken }),
    });
    url = localServer.url;
  }
  if (url === undefined) {
    throw new Error("Failed to create an App Server endpoint");
  }
  const client = await CodexClient.connect(url, {
    ...(bearerToken === undefined ? {} : { bearerToken }),
  });
  await client.initialize({
    name: "zen-cli",
    title: "Zen CLI",
    version: "0.1.0",
  });
  return localServer === undefined ? { client } : { client, localServer };
}

async function openThread(
  client: CodexClient,
  args: ParsedArguments,
  local: boolean,
): Promise<string> {
  const existing = option(args, "thread");
  const requestedModel = option(args, "model");
  const requestedApproval = option(args, "approval");
  const response =
    existing === undefined
      ? await client.request("thread/start", {
          cwd: workingDirectory(args),
          ...(local || requestedModel !== undefined
            ? {
                model:
                  requestedModel ??
                  modelName(args, option(args, "provider") ?? "fake"),
              }
            : {}),
          ...(local || requestedApproval !== undefined
            ? {
                approvalPolicy:
                  (requestedApproval ?? DEFAULT_APPROVAL_POLICY) === "never"
                    ? "never"
                    : "on-request",
              }
            : {}),
          ...(local ? { sandbox: "danger-full-access" } : {}),
        })
      : await client.request("thread/resume", { threadId: existing });
  const thread = responseResult<Record<string, unknown>>(response, "thread");
  if (typeof thread.id !== "string") {
    throw new Error("App Server response omitted thread.id");
  }
  return thread.id;
}

async function runOneTurn(
  client: CodexClient,
  threadId: string,
  text: string,
): Promise<void> {
  let expectedTurnId: string | undefined;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const streamedItems = new Set<string>();
  const disposers = [
    client.onNotification("item/agentMessage/delta", (params) => {
      if (!isRecord(params) || params.threadId !== threadId) {
        return;
      }
      if (typeof params.itemId === "string") {
        streamedItems.add(params.itemId);
      }
      if (typeof params.delta === "string") {
        process.stdout.write(params.delta);
      }
    }),
    client.onNotification("item/completed", (params) => {
      if (
        !isRecord(params) ||
        params.threadId !== threadId ||
        !isRecord(params.item)
      ) {
        return;
      }
      if (
        params.item.type === "agentMessage" &&
        typeof params.item.id === "string" &&
        typeof params.item.text === "string" &&
        !streamedItems.has(params.item.id)
      ) {
        process.stdout.write(params.item.text);
      }
    }),
    client.onNotification("turn/completed", (params) => {
      if (
        !isRecord(params) ||
        params.threadId !== threadId ||
        !isRecord(params.turn)
      ) {
        return;
      }
      if (expectedTurnId !== undefined && params.turn.id !== expectedTurnId) {
        return;
      }
      if (params.turn.status === "failed") {
        const message =
          isRecord(params.turn.error) &&
          typeof params.turn.error.message === "string"
            ? params.turn.error.message
            : "Turn failed";
        rejectCompletion(new Error(message));
      } else {
        resolveCompletion();
      }
    }),
    client.onNotification("error", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.error) &&
        typeof params.error.message === "string"
      ) {
        process.stderr.write(`\nZen error: ${params.error.message}\n`);
      }
    }),
  ];

  try {
    const response = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    const turn = responseResult<Record<string, unknown>>(response, "turn");
    if (typeof turn.id !== "string") {
      throw new Error("App Server response omitted turn.id");
    }
    expectedTurnId = turn.id;
    await completion;
    process.stdout.write("\n");
  } finally {
    for (const dispose of disposers) {
      dispose();
    }
  }
}

function hostOptions(args: ParsedArguments) {
  const providerName = option(args, "provider") ?? "fake";
  let provider: HostProvider;
  let secretEnvironmentVariables: readonly string[] = [];
  if (providerName === "fake") {
    provider = { type: "fake" };
  } else if (providerName === "openai-subscription") {
    provider = {
      type: "openai-subscription",
      profilePath: subscriptionProfilePath(args),
    };
  } else if (providerName === "openai-compatible") {
    const environmentVariable = option(args, "api-key-env") ?? "OPENAI_API_KEY";
    if (option(args, "model") === undefined) {
      throw new Error("--model is required with --provider openai-compatible");
    }
    const apiKey = process.env[environmentVariable];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        `API key environment variable ${environmentVariable} is not set`,
      );
    }
    delete process.env[environmentVariable];
    provider = {
      type: "openai-compatible",
      baseUrl: option(args, "base-url") ?? "https://api.openai.com/v1",
      apiKey,
      name: option(args, "provider-name") ?? "openai",
    };
    secretEnvironmentVariables = [environmentVariable];
  } else {
    throw new Error(`Unsupported provider: ${providerName}`);
  }
  const approval = option(args, "approval") ?? DEFAULT_APPROVAL_POLICY;
  if (approval !== "always" && approval !== "never") {
    throw new Error("--approval must be always or never");
  }
  return {
    cwd: workingDirectory(args),
    dataDirectory: dataDirectory(args),
    model: modelName(args, providerName),
    approvalPolicy: approval,
    provider,
    secretEnvironmentVariables,
  } as const;
}

function parseArguments(args: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  const booleanOptions = new Set(["approve", "deny"]);
  const allowedOptions = new Set([
    "api-key-env",
    "approval",
    "approve",
    "auth-token-file",
    "base-url",
    "cwd",
    "data-dir",
    "deny",
    "listen",
    "model",
    "provider",
    "provider-name",
    "remote",
    "thread",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) {
      continue;
    }
    if (value === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!allowedOptions.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (booleanOptions.has(name)) {
      options.set(name, true);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined) {
      throw new Error(`Option --${name} requires a value`);
    }
    options.set(name, next);
    index += 1;
  }
  return { options, positionals };
}

function parseAppServerArguments(args: string[]): ParsedArguments {
  const filtered: string[] = [];
  let ignoredT3McpConfiguration = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value !== "-c") {
      if (value !== undefined) {
        filtered.push(value);
      }
      continue;
    }
    const configuration = args[index + 1];
    if (configuration === undefined) {
      throw new Error("Option -c requires a value");
    }
    assertIgnorableT3McpConfiguration(configuration);
    ignoredT3McpConfiguration = true;
    index += 1;
  }
  const parsed = parseArguments(filtered);
  if (ignoredT3McpConfiguration && option(parsed, "remote") === undefined) {
    throw new Error(
      "T3 MCP -c options are accepted only with app-server --remote",
    );
  }
  return parsed;
}

function assertIgnorableT3McpConfiguration(value: string): void {
  const urlPrefix = "mcp_servers.t3-code.url=";
  if (value.startsWith(urlPrefix)) {
    const endpoint = unquote(value.slice(urlPrefix.length));
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("T3 MCP URL configuration is invalid");
    }
    if (
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname) ||
      parsed.pathname !== "/mcp" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("T3 MCP URL must be a credential-free loopback /mcp URL");
    }
    return;
  }
  const bearerPrefix = "mcp_servers.t3-code.bearer_token_env_var=";
  if (
    value.startsWith(bearerPrefix) &&
    unquote(value.slice(bearerPrefix.length)) === "T3_MCP_BEARER_TOKEN"
  ) {
    return;
  }
  throw new Error("Unsupported -c configuration for the Zen T3 bridge");
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function option(args: ParsedArguments, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function flag(args: ParsedArguments, name: string): boolean {
  return args.options.get(name) === true;
}

function workingDirectory(args: ParsedArguments): string {
  return path.resolve(option(args, "cwd") ?? process.cwd());
}

function dataDirectory(args: ParsedArguments): string {
  return path.resolve(
    option(args, "data-dir") ?? path.join(os.homedir(), ".zen"),
  );
}

function modelName(args: ParsedArguments, providerName: string): string {
  return (
    option(args, "model") ??
    (providerName === "openai-subscription"
      ? DEFAULT_OPENAI_SUBSCRIPTION_MODEL
      : "fake")
  );
}

function subscriptionProfilePath(args: ParsedArguments): string {
  return path.join(dataDirectory(args), "openai-subscription-auth.json");
}

async function loadBearerToken(
  args: ParsedArguments,
): Promise<string | undefined> {
  const filePath = option(args, "auth-token-file");
  return filePath === undefined
    ? undefined
    : await readBearerTokenFile(path.resolve(filePath));
}

function assertNoPositionals(args: ParsedArguments): void {
  if (args.positionals.length > 0) {
    throw new Error(`Unexpected arguments: ${args.positionals.join(" ")}`);
  }
}

async function waitForShutdown(server: CodexWebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
}

function printHelp(): void {
  process.stdout.write(`Zen — local personal agent runtime

Usage:
  zen app-server [--listen ws://127.0.0.1:4500] [--auth-token-file <path>]
  zen app-server --remote ws://127.0.0.1:4500 [--auth-token-file <path>]
  zen run [options] <prompt>
  zen chat [options]
  zen threads [options]
  zen auth login
  zen auth status
  zen auth logout

Core options:
  --cwd <path>                 Thread working directory
  --data-dir <path>            Host-owned Zen data directory
  --model <name>               Model name (defaults to fake, or gpt-5.6-terra for subscription)
  --approval always|never      Tool approval policy (default: never / Full Access)
  --remote <ws://...>          Connect to an existing Zen App Server
  --auth-token-file <path>     Bearer token file for WebSocket transport
  --thread <id>                Resume an existing Thread
  --provider fake|openai-subscription|openai-compatible
  --base-url <url>             OpenAI-compatible API base URL
  --api-key-env <name>         Name of the host environment variable containing the key
`);
}

function openBrowser(url: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  const child = spawn("open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `zen: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

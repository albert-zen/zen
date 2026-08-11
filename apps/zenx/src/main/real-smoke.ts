import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, session } from "electron";

import { OpenAiSubscriptionAuthProfile } from "../../../../apps/cli/src/subscription-auth.js";
import { AppServerManager } from "./app-server-manager.js";
import type { BrowserInspection } from "./capabilities/browser-provider.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "./capabilities/self-control-package.js";
import { ZenXCapabilityService } from "./capability-service.js";
import { zenXProviderTransport } from "./system-proxy.js";
import type { ServerNotificationParams } from "../protocol-client/index.js";
import { ZenXTriggerService } from "./trigger-service.js";
import { ZenXTriggerStore } from "./trigger-store.js";

type SmokeStatus = "passed" | "blocked" | "failed";

interface SmokeCheck {
  name: string;
  status: SmokeStatus;
  detail: string;
  durationMs: number;
}

interface SmokeReport {
  version: 1;
  startedAt: string;
  completedAt: string;
  isolated: true;
  cleanup: "completed" | "failed";
  checks: SmokeCheck[];
}

const reportPath = path.resolve(
  process.env["ZENX_REAL_SMOKE_REPORT"] ??
    path.join(
      process.env["INIT_CWD"] ?? process.cwd(),
      "apps/zenx/.smoke/real-smoke-report.json",
    ),
);
const sourceAuthPath = path.resolve(
  process.env["ZENX_REAL_SMOKE_AUTH_PROFILE"] ??
    path.join(os.homedir(), ".zen/openai-subscription-auth.json"),
);
const model = process.env["ZENX_REAL_SMOKE_MODEL"] ?? "gpt-5.6-terra";
const runForeground = process.env["ZENX_REAL_SMOKE_FOREGROUND"] !== "0";
const checks: SmokeCheck[] = [];
const startedAt = new Date().toISOString();

let rootDirectory: string | undefined;
let manager: AppServerManager | undefined;
let capabilities: ZenXCapabilityService | undefined;
let triggers: ZenXTriggerService | undefined;
let webServer: Server | undefined;
let cleanup: SmokeReport["cleanup"] = "completed";

void app.whenReady().then(async () => {
  const keepAlive = new BrowserWindow({ show: false, width: 1, height: 1 });
  try {
    rootDirectory = await mkdtemp(path.join(os.tmpdir(), "zenx-real-smoke-"));
    const userDataDirectory = path.join(rootDirectory, "user-data");
    const dataDirectory = path.join(rootDirectory, "zen-data");
    const workspace = path.join(rootDirectory, "workspace");
    await Promise.all([
      mkdir(userDataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(workspace, { recursive: true, mode: 0o700 }),
    ]);
    app.setPath("userData", userDataDirectory);

    let authenticated = false;
    const authTarget = path.join(
      userDataDirectory,
      "openai-subscription-auth.json",
    );
    await check("openai-subscription", async () => {
      try {
        await copyFile(sourceAuthPath, authTarget);
        await chmod(authTarget, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw blocked(
            "No existing OpenAI subscription profile was found; authenticate Zen and retry",
          );
        }
        throw error;
      }
      const status = await new OpenAiSubscriptionAuthProfile(
        authTarget,
      ).status();
      if (!status.authenticated) {
        throw blocked(
          "The existing OpenAI subscription profile is not authenticated",
        );
      }
      authenticated = true;
      return status.expired
        ? "Existing isolated credential copy is authenticated and will refresh on demand"
        : "Existing isolated credential copy is authenticated";
    });

    const useRealProvider = authenticated;
    const realHostConfig = {
      cwd: workspace,
      dataDirectory,
      model,
      models: [model],
      approvalPolicy: "never" as const,
      provider: {
        type: "openai-subscription" as const,
        profilePath: authTarget,
      },
    };
    const fakeHostConfig = {
      cwd: workspace,
      dataDirectory,
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never" as const,
      provider: { type: "fake" as const },
    };
    const baseHostConfig = useRealProvider ? realHostConfig : fakeHostConfig;
    const transport = await zenXProviderTransport(
      baseHostConfig,
      async (url) => await session.defaultSession.resolveProxy(url),
    );
    const hostConfig = {
      ...baseHostConfig,
      ...(transport === undefined ? {} : { transport }),
    };
    if (useRealProvider) {
      await check("system-proxy-projection", async () => {
        const mode = transport
          ? "Explicit credential-free ProxyAgent transport configured for the provider child"
          : "System resolver selected a direct provider route";
        return mode;
      });
    } else {
      recordBlocked(
        "system-proxy-projection",
        "Skipped because no authenticated subscription profile is available",
      );
    }

    const port = new MutableAppServerRequestPort();
    capabilities = new ZenXCapabilityService({ userDataDirectory });
    await capabilities.initialize();
    capabilities.register(
      new ZenXSelfControlCapabilityPackage({ appServer: port }),
    );
    await capabilities.grant("zenx-self-control");

    manager = new AppServerManager({
      entryPath: path.join(__dirname, "app-server-host.js"),
      tokenFile: path.join(userDataDirectory, "runtime/app-server.token"),
      hostConfig,
      execPath: process.execPath,
      capabilityHost: capabilities,
      startupTimeoutMs: 20_000,
    });
    port.attach(manager, workspace);

    await check("hosted-app-server", async () => {
      await manager!.start();
      assert.deepEqual(manager!.status, { type: "ready", reconnected: false });
      return "Production-built child host reached ready on an isolated port and data directory";
    });

    let realModelAvailable = false;
    if (useRealProvider) {
      await check("real-model-turn", async () => {
        try {
          const thread = (
            await manager!.request("thread/start", {
              cwd: workspace,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            })
          ).thread;
          const completed = waitForTurnCompleted(manager!, thread.id);
          await manager!.request("turn/start", {
            threadId: thread.id,
            clientUserMessageId: "zenx-real-smoke-agent-control",
            input: [
              {
                type: "text",
                text: "Call zenx_projects_list exactly once with limit 5. After the tool succeeds, reply exactly ZENX_REAL_SMOKE_OK.",
              },
            ],
          });
          await completed;
          const read = await manager!.request("thread/read", {
            threadId: thread.id,
            includeTurns: true,
          });
          const items = read.thread.turns.flatMap((turn) => turn.items);
          const command = items.find(
            (item) =>
              item.type === "commandExecution" &&
              item.command.startsWith("zenx_projects_list "),
          );
          assert.equal(command?.type, "commandExecution");
          assert.equal(command?.status, "completed");
          const answer = [...items]
            .reverse()
            .find((item) => item.type === "agentMessage");
          assert.equal(answer?.type, "agentMessage");
          if (answer?.type === "agentMessage") {
            assert.match(answer.text, /ZENX_REAL_SMOKE_OK/u);
          }
          realModelAvailable = true;
          return "OpenAI subscription completed a real turn and invoked ZenX self-control through the hosted capability bridge";
        } catch (error) {
          if (/failed before receiving a response/iu.test(safeError(error))) {
            throw blocked(
              "Provider child received no endpoint response after system proxy projection; DNS/TLS/proxy/endpoint remains externally blocked",
            );
          }
          throw error;
        }
      });
    } else {
      recordBlocked(
        "real-model-turn",
        "OpenAI subscription authentication or endpoint connectivity is unavailable; all non-provider smoke continued with the fake adapter",
      );
    }
    if (!realModelAvailable && useRealProvider) {
      await manager.restart(fakeHostConfig);
    }

    await check("agent-self-control", async () => {
      const projects = await invokeCapability("zenx_projects_list", {
        limit: 10,
      });
      assert(Array.isArray(field(projects, "projects")));
      const created = await invokeCapability("zenx_threads_create", {
        cwd: workspace,
        model: realModelAvailable ? model : "fake",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      const threadId = stringField(created, "threadId");
      const listed = await invokeCapability("zenx_threads_list", {
        workspace,
        query: threadId.slice(0, 8),
        limit: 10,
      });
      assert(
        (field(listed, "threads") as Array<{ threadId?: string }>).some(
          (thread) => thread.threadId === threadId,
        ),
      );
      const completion = waitForTurnCompleted(manager!, threadId);
      await invokeCapability("zenx_threads_send", {
        threadId,
        mode: "start",
        text: "Reply exactly ZENX_SELF_CONTROL_OK.",
        clientUserMessageId: "zenx-real-smoke-self-control-send",
      });
      await completion;
      const status = await invokeCapability("zenx_threads_status", {
        threadId,
      });
      assert.equal(field(status, "status"), "idle");
      const read = await invokeCapability("zenx_threads_read", {
        threadId,
        maxTurns: 2,
        maxItemsPerTurn: 20,
      });
      assert.match(JSON.stringify(read), /zenx-real-smoke-self-control-send/u);
      return "projects/list and threads/list/create/send/status/read completed through the granted ZenX self-control package";
    });

    triggers = new ZenXTriggerService(
      manager,
      new ZenXTriggerStore(path.join(userDataDirectory, "smoke-triggers.json")),
    );
    await triggers.start();
    await check("room-mention-relay", async () => {
      const source = (
        await manager!.request("thread/start", { cwd: workspace })
      ).thread;
      const relay = (await manager!.request("thread/start", { cwd: workspace }))
        .thread;
      const roomMember = (
        await manager!.request("thread/start", { cwd: workspace })
      ).thread;
      const watch = await triggers!.create({
        threadId: relay.id,
        kind: "thread",
        label: "Real smoke relay",
        prompt:
          "Acknowledge the bounded source conclusion in one short sentence.",
        watchedThreadId: source.id,
      });
      const room = await triggers!.createRoom({
        name: "zenx-real-smoke",
        members: [{ name: "Smoke", threadId: roomMember.id }],
      });
      const mention = await triggers!.create({
        threadId: roomMember.id,
        kind: "roomMention",
        label: "Real smoke mention",
        prompt: "Answer the Room request in one short sentence.",
        roomId: room.id,
        mention: "Smoke",
      });
      await manager!.request("turn/start", {
        threadId: source.id,
        clientUserMessageId: "zenx-real-smoke-relay-source",
        input: [{ type: "text", text: "Reply exactly RELAY_SOURCE_OK." }],
      });
      await waitForTriggerHistory(
        triggers!,
        (entry) =>
          entry.triggerId === watch.id &&
          (entry.status === "completed" || entry.status === "failed"),
      );
      assert.equal(
        triggers!
          .snapshot()
          .history.find((entry) => entry.triggerId === watch.id)?.status,
        "completed",
      );
      await triggers!.cancel(watch.id);
      await triggers!.postRoomMessage(
        room.id,
        "Smoke runner",
        "@Smoke reply with ROOM_MENTION_OK.",
      );
      await waitForTriggerHistory(
        triggers!,
        (entry) =>
          entry.triggerId === mention.id &&
          (entry.status === "completed" || entry.status === "failed"),
      );
      assert.equal(
        triggers!
          .snapshot()
          .history.find((entry) => entry.triggerId === mention.id)?.status,
        "completed",
      );
      await triggers!.cancel(mention.id);
      const projectedRoom = triggers!
        .snapshot()
        .rooms.find((entry) => entry.id === room.id);
      assert(
        projectedRoom?.messages.some(
          (message) =>
            message.kind === "agent" &&
            message.originThreadId === roomMember.id,
        ),
      );
      return "A completed source Turn woke a watched Thread, and an explicit Room mention produced a linked Agent Room message";
    });

    await capabilities.grant("browser");
    await check("background-isolated-browser", async () => {
      const { server, port: browserPort } = await startSmokeWebServer();
      webServer = server;
      const sessionId = "zenx-real-smoke";
      const opened = await invokeCapability("browser_open", {
        sessionId,
        url: `http://127.0.0.1:${String(browserPort)}/`,
      });
      const tabId = stringField(opened, "tabId");
      let inspection = (await invokeCapability("browser_inspect", {
        sessionId,
        tabId,
      })) as unknown as BrowserInspection;
      const input = inspection.targets.find(
        (target) =>
          target.name === "Smoke text" && target.actions.includes("type"),
      );
      assert(input !== undefined);
      await invokeCapability("browser_type", {
        sessionId,
        tabId,
        observationId: inspection.observationId,
        targetId: input.targetId,
        text: "isolated-browser",
      });
      inspection = (await invokeCapability("browser_inspect", {
        sessionId,
        tabId,
      })) as unknown as BrowserInspection;
      const button = inspection.targets.find(
        (target) => target.name === "Apply" && target.actions.includes("click"),
      );
      assert(button !== undefined);
      await invokeCapability("browser_click", {
        sessionId,
        tabId,
        observationId: inspection.observationId,
        targetId: button.targetId,
      });
      inspection = (await invokeCapability("browser_inspect", {
        sessionId,
        tabId,
      })) as unknown as BrowserInspection;
      assert.match(inspection.visibleText, /Applied isolated-browser/u);
      const closed = await invokeCapability("browser_close_session", {
        sessionId,
      });
      assert.equal(field(closed, "closedTabs"), 1);
      await closeServer(server);
      webServer = undefined;
      return "Hidden ephemeral Chromium opened, inspected, typed, clicked, verified, and closed without attaching the user browser profile";
    });

    if (process.platform !== "darwin") {
      recordBlocked(
        "macos-foreground-computer",
        "The foreground baseline is currently implemented only on macOS",
      );
    } else if (!runForeground) {
      recordBlocked(
        "macos-foreground-computer",
        "Skipped because ZENX_REAL_SMOKE_FOREGROUND=0",
      );
    } else {
      await capabilities.grant("computer");
      await check("macos-foreground-computer", async () => {
        let fixture: ForegroundFixture;
        try {
          fixture = await launchForegroundFixture();
        } catch (error) {
          const message = safeError(error);
          if (message.includes("ownerName=loginwindow")) {
            throw blocked(
              "The macOS GUI session is locked (loginwindow is frontmost); unlock it and rerun to exercise the real foreground CGEvent baseline",
            );
          }
          throw error;
        }
        try {
          await invokeForegroundCapability(
            fixture,
            "computer_foreground_click",
            {
              x: fixture.clickX,
              y: fixture.clickY,
              button: "left",
            },
          );
          await waitForFile(fixture.clickedPath, 2_000, "fixture click marker");
          await invokeForegroundCapability(
            fixture,
            "computer_foreground_key_press",
            { key: "escape" },
          );
          await invokeForegroundCapability(
            fixture,
            "computer_foreground_scroll",
            { deltaY: 120 },
          );
          await assertForegroundFixtureOwned(fixture);
          return "Real CGEvent click/key/scroll ran against a separately spawned smoke-owned AppKit process/window; exact PID/title/key-window ownership was checked every 25ms";
        } finally {
          await stopForegroundFixture(fixture);
        }
      });
    }
  } catch (error) {
    checks.push({
      name: "smoke-runner",
      status: "failed",
      detail: safeError(error),
      durationMs: 0,
    });
  } finally {
    await triggers?.close().catch(() => {
      cleanup = "failed";
    });
    await closeServer(webServer).catch(() => {
      cleanup = "failed";
    });
    await manager?.stop().catch(() => {
      cleanup = "failed";
    });
    await capabilities?.close().catch(() => {
      cleanup = "failed";
    });
    if (rootDirectory !== undefined) {
      await rm(rootDirectory, { recursive: true, force: true }).catch(() => {
        cleanup = "failed";
      });
    }
    const exitCode = checks.some((entry) => entry.status === "failed") ? 1 : 0;
    await writeReport();
    if (!keepAlive.isDestroyed()) keepAlive.destroy();
    app.exit(exitCode);
  }
});

async function check(
  name: string,
  operation: () => Promise<string>,
): Promise<void> {
  const started = Date.now();
  try {
    const detail = await operation();
    checks.push({
      name,
      status: "passed",
      detail,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    checks.push({
      name,
      status: isBlocked(error) ? "blocked" : "failed",
      detail: safeError(error),
      durationMs: Date.now() - started,
    });
  }
}

function recordBlocked(name: string, detail: string): void {
  checks.push({ name, status: "blocked", detail, durationMs: 0 });
}

function blocked(message: string): Error & { smokeBlocked: true } {
  return Object.assign(new Error(message), { smokeBlocked: true as const });
}

function isBlocked(error: unknown): boolean {
  return (
    error instanceof Error &&
    "smokeBlocked" in error &&
    error.smokeBlocked === true
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /(?:access|refresh|token|secret|credential)=[^\s&]+/giu,
      "credential=[redacted]",
    )
    .slice(0, 2_000);
}

async function writeReport(): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  const report: SmokeReport = {
    version: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    isolated: true,
    cleanup,
    checks,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function invokeCapability(
  name: string,
  arguments_: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<Record<string, unknown>> {
  if (capabilities === undefined || rootDirectory === undefined) {
    throw new Error("Capability smoke host is unavailable");
  }
  const result = await capabilities.execute({
    callId: `real-smoke-${name}-${String(Date.now())}`,
    name,
    arguments: arguments_,
    cwd: path.join(rootDirectory, "workspace"),
    signal,
  });
  const envelope = JSON.parse(result.output) as { result?: unknown };
  if (
    typeof envelope.result !== "object" ||
    envelope.result === null ||
    Array.isArray(envelope.result)
  ) {
    throw new Error(`${name} returned no structured object result`);
  }
  return envelope.result as Record<string, unknown>;
}

interface ForegroundFixture {
  launcher: ChildProcess;
  pid: number;
  clickX: number;
  clickY: number;
  readyPath: string;
  clickedPath: string;
  driftPath: string;
}

async function launchForegroundFixture(): Promise<ForegroundFixture> {
  if (rootDirectory === undefined) {
    throw new Error("Foreground smoke root directory is unavailable");
  }
  const source = path.join(rootDirectory, "zenx-smoke-fixture.swift");
  const bundle = path.join(rootDirectory, "ZenXForegroundSmoke.app");
  const executable = path.join(bundle, "Contents/MacOS/ZenXForegroundSmoke");
  await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(bundle, "Contents/Info.plist"),
    FIXTURE_INFO_PLIST,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  const readyPath = path.join(rootDirectory, "foreground-ready.tsv");
  const clickedPath = path.join(rootDirectory, "foreground-clicked");
  const driftPath = path.join(rootDirectory, "foreground-drift");
  await writeFile(source, MAC_FOREGROUND_FIXTURE_SOURCE, {
    encoding: "utf8",
    mode: 0o600,
  });
  await execFileText(
    "/usr/bin/swiftc",
    ["-O", source, "-o", executable],
    60_000,
  );
  const child = spawn(
    "/usr/bin/open",
    [
      "-n",
      "-W",
      "-F",
      "-a",
      bundle,
      "--args",
      readyPath,
      clickedPath,
      driftPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 2_000) stderr.push(chunk);
  });
  if (child.pid === undefined) {
    child.kill("SIGTERM");
    throw new Error("Foreground smoke fixture did not start");
  }
  // LaunchServices may create the process before granting it foreground
  // ownership when the smoke itself is a background Electron entrypoint.
  // Re-opening the already-running, uniquely identified fixture is the same
  // user-visible activation that Finder performs for an application click.
  await delay(250);
  await execFileText("/usr/bin/open", ["-a", bundle], 5_000);
  await waitForFixtureReady(child, readyPath, driftPath, stderr, 5_000);
  const fields = (await readFile(readyPath, "utf8")).trim().split("\t");
  const pid = Number(fields[0]);
  const clickX = Number(fields[2]);
  const clickY = Number(fields[3]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    fields[1] !== "ZenX Foreground Smoke" ||
    !Number.isFinite(clickX) ||
    !Number.isFinite(clickY)
  ) {
    child.kill("SIGTERM");
    throw new Error("Foreground fixture returned an invalid ownership marker");
  }
  const fixture = {
    launcher: child,
    pid,
    clickX,
    clickY,
    readyPath,
    clickedPath,
    driftPath,
  };
  await assertForegroundFixtureOwned(fixture);
  return fixture;
}

async function waitForFixtureReady(
  child: ChildProcess,
  readyPath: string,
  driftPath: string,
  stderr: Buffer[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(readyPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) {
      const diagnostic = await readFile(driftPath, "utf8").catch(() =>
        Buffer.concat(stderr).toString("utf8").trim(),
      );
      throw new Error(
        `Foreground fixture exited before ready (${diagnostic || `exitCode=${String(child.exitCode)}`})`,
      );
    }
    await delay(25);
  }
  const diagnostic = await readFile(driftPath, "utf8").catch(() =>
    Buffer.concat(stderr).toString("utf8").trim(),
  );
  throw new Error(
    `foreground fixture ready marker timed out${diagnostic ? ` (${diagnostic})` : ""}`,
  );
}

async function invokeForegroundCapability(
  fixture: ForegroundFixture,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await assertForegroundFixtureOwned(fixture);
  const controller = new AbortController();
  const validate = async (): Promise<void> => {
    try {
      await assertForegroundFixtureOwned(fixture);
    } catch (error) {
      controller.abort(error);
    }
  };
  const timer = setInterval(() => void validate(), 25);
  try {
    return await invokeCapability(name, arguments_, controller.signal);
  } finally {
    clearInterval(timer);
    await assertForegroundFixtureOwned(fixture);
  }
}

async function assertForegroundFixtureOwned(
  fixture: ForegroundFixture,
): Promise<void> {
  try {
    process.kill(fixture.pid, 0);
  } catch {
    throw new Error("Foreground smoke fixture process exited");
  }
  try {
    await access(fixture.driftPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const diagnostic = (await readFile(fixture.driftPath, "utf8")).trim();
  throw new Error(
    `Foreground fixture lost exact PID/title/key-window ownership (${diagnostic || "diagnostic unavailable"})`,
  );
}

async function stopForegroundFixture(
  fixture: ForegroundFixture,
): Promise<void> {
  try {
    process.kill(fixture.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) =>
      fixture.launcher.once("exit", () => resolve()),
    ),
    delay(2_000),
  ]);
  try {
    process.kill(fixture.pid, "SIGKILL");
  } catch {
    // The fixture already exited.
  }
}

async function waitForFile(
  filePath: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error(`${label} timed out`);
}

async function execFileText(
  command: string,
  arguments_: string[],
  timeout: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, arguments_, { timeout }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    );
  });
}

const MAC_FOREGROUND_FIXTURE_SOURCE = `import AppKit
import ApplicationServices
import Foundation

guard CommandLine.arguments.count == 4 else { exit(2) }
let readyPath = CommandLine.arguments[1]
let clickedPath = CommandLine.arguments[2]
let driftPath = CommandLine.arguments[3]
let expectedTitle = "ZenX Foreground Smoke"

func claimForeground() {
  var process = ProcessSerialNumber(
    highLongOfPSN: 0,
    lowLongOfPSN: UInt32(kCurrentProcess)
  )
  _ = TransformProcessType(
    &process,
    ProcessApplicationTransformState(kProcessTransformToForegroundApplication)
  )
  _ = NSRunningApplication.current.activate(
    options: [.activateAllWindows, .activateIgnoringOtherApps]
  )
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var ownershipTimer: Timer?
  var activationPolicyAccepted = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let screen = NSScreen.screens.first else { exit(3) }
    let frame = NSRect(
      x: screen.frame.midX - 240,
      y: screen.frame.midY - 180,
      width: 480,
      height: 360
    )
    window = NSWindow(
      contentRect: frame,
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = expectedTitle
    let button = NSButton(frame: NSRect(x: 120, y: 120, width: 240, height: 100))
    button.title = "ZenX foreground smoke"
    button.bezelStyle = .rounded
    button.target = self
    button.action = #selector(clicked)
    window.contentView?.addSubview(button)
    NSApp.unhide(nil)
    window.orderFrontRegardless()
    window.makeMain()
    window.makeKey()
    claimForeground()
    waitUntilOwned(button: button, screen: screen, attempts: 0)
  }

  func waitUntilOwned(button: NSButton, screen: NSScreen, attempts: Int) {
    let owned = NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()
      && window.isKeyWindow
      && window.title == expectedTitle
    if owned {
      let contentRect = button.convert(button.bounds, to: nil)
      let screenRect = window.convertToScreen(contentRect)
      let clickX = screenRect.midX
      let clickY = screen.frame.maxY - screenRect.midY
      let marker = String(getpid()) + "\\t" + expectedTitle + "\\t"
        + String(Int(clickX)) + "\\t" + String(Int(clickY)) + "\\n"
      try? marker.write(toFile: readyPath, atomically: true, encoding: .utf8)
      ownershipTimer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { _ in
        let ownerExact = NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()
        let titleExact = self.window.title == expectedTitle
        let keyWindow = self.window.isKeyWindow
        if !ownerExact || !titleExact || !keyWindow {
          let diagnostic = "frontOwnerExact=" + String(ownerExact)
            + ", exactTitle=" + String(titleExact)
            + ", keyWindow=" + String(keyWindow)
            + ", axTrusted=" + String(AXIsProcessTrusted())
          try? diagnostic.write(toFile: driftPath, atomically: true, encoding: .utf8)
        }
      }
      return
    }
    if attempts >= 30 {
      let owner = NSWorkspace.shared.frontmostApplication
      let diagnostic = "frontOwnerExact=" + String(NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid())
        + ", ownerPid=" + String(owner?.processIdentifier ?? -1)
        + ", ownerName=" + (owner?.localizedName ?? "nil")
        + ", activationPolicyAccepted=" + String(activationPolicyAccepted)
        + ", exactTitle=" + String(window.title == expectedTitle)
        + ", keyWindow=" + String(window.isKeyWindow)
        + ", axTrusted=" + String(AXIsProcessTrusted())
      try? diagnostic.write(toFile: driftPath, atomically: true, encoding: .utf8)
      exit(4)
    }
    NSApp.unhide(nil)
    window.orderFrontRegardless()
    window.makeMain()
    window.makeKey()
    claimForeground()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
      self.waitUntilOwned(button: button, screen: screen, attempts: attempts + 1)
    }
  }

  @objc func clicked() {
    try? "clicked\\n".write(toFile: clickedPath, atomically: true, encoding: .utf8)
  }
}

let delegate = FixtureDelegate()
let application = NSApplication.shared
delegate.activationPolicyAccepted = application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
`;

const FIXTURE_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>ZenXForegroundSmoke</string>
  <key>CFBundleIdentifier</key><string>dev.zenx.real-smoke.foreground</string>
  <key>CFBundleName</key><string>ZenX Foreground Smoke</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSBackgroundOnly</key><false/>
  <key>LSUIElement</key><false/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;

function field(value: Record<string, unknown>, name: string): unknown {
  return value[name];
}

function stringField(value: Record<string, unknown>, name: string): string {
  const result = field(value, name);
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Smoke result is missing ${name}`);
  }
  return result;
}

async function waitForTurnCompleted(
  target: AppServerManager,
  threadId: string,
): Promise<void> {
  await within(
    new Promise<void>((resolve, reject) => {
      const unsubscribe = target.onNotification((method, params) => {
        if (method !== "turn/completed") return;
        const completed = params as ServerNotificationParams["turn/completed"];
        if (completed.threadId !== threadId) return;
        unsubscribe();
        if (completed.turn.status === "completed") resolve();
        else reject(new Error(completed.turn.error?.message ?? "Turn failed"));
      });
    }),
    180_000,
    `Turn completion for ${threadId}`,
  );
}

async function waitForTriggerHistory(
  service: ZenXTriggerService,
  predicate: (
    entry: ReturnType<ZenXTriggerService["snapshot"]>["history"][number],
  ) => boolean,
): Promise<void> {
  if (service.snapshot().history.some(predicate)) return;
  await within(
    new Promise<void>((resolve) => {
      const unsubscribe = service.onChange((snapshot) => {
        if (!snapshot.history.some(predicate)) return;
        unsubscribe();
        resolve();
      });
    }),
    180_000,
    "Trigger history completion",
  );
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function startSmokeWebServer(): Promise<{
  server: Server;
  port: number;
}> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><input aria-label='Smoke text'><button onclick=\"document.querySelector('output').textContent='Applied '+document.querySelector('input').value\">Apply</button><output></output>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Browser smoke server did not bind a port");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

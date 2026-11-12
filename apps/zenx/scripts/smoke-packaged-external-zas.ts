import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  readZenXConnectionDescriptor,
  ZenXProtocolClient,
} from "../src/protocol-client/index.js";

const run = promisify(execFile);
const zenxDirectory = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

if (process.platform !== "darwin") {
  throw new Error("Packaged external ZAS smoke currently runs on macOS only");
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "zenx-packaged-external-zas-"),
);
const userDataDirectory = path.join(temporaryRoot, "user-data");
const zenDataDirectory = path.join(temporaryRoot, "zen-data");
const acceptanceConfig = path.join(temporaryRoot, "acceptance.json");
const controlPath = path.join(temporaryRoot, "control.json");
const resultPath = path.join(temporaryRoot, "result.json");
const descriptorPath = path.join(
  userDataDirectory,
  "runtime",
  "app-server.json",
);
let application: ChildProcess | undefined;
let external: ZenXProtocolClient | undefined;
let applicationLogs = "";

try {
  await writeFile(
    path.join(temporaryRoot, "host-profile.json"),
    `${JSON.stringify(fakeHostProfile())}\n`,
    "utf8",
  );
  await writeFile(
    acceptanceConfig,
    `${JSON.stringify({ controlPath, resultPath })}\n`,
    "utf8",
  );

  const packaged = await packageApplication();
  await rm(userDataDirectory, { recursive: true, force: true });
  await rm(zenDataDirectory, { recursive: true, force: true });
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(userDataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(zenDataDirectory, { recursive: true, mode: 0o700 });
  await copyFile(
    path.join(temporaryRoot, "host-profile.json"),
    path.join(userDataDirectory, "host-profile.json"),
  );

  const environment = {
    ...process.env,
    ZENX_DATA_DIR: zenDataDirectory,
    ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG: acceptanceConfig,
  };
  application = spawn(
    packaged.executable,
    [`--user-data-dir=${userDataDirectory}`],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  application.stdout?.on("data", (chunk) => {
    applicationLogs += chunk.toString();
  });
  application.stderr?.on("data", (chunk) => {
    applicationLogs += chunk.toString();
  });

  await waitFor(async () => await exists(descriptorPath), "public descriptor");
  const descriptorSource = await readFile(descriptorPath, "utf8");
  const descriptor = await readZenXConnectionDescriptor(descriptorPath);
  const bearerToken = (
    await readFile(descriptor.authentication.tokenFile, "utf8")
  ).trim();
  external = await ZenXProtocolClient.connect({
    url: descriptor.url,
    bearerTokenFile: descriptor.authentication.tokenFile,
    clientInfo: {
      name: "zx1-packaged-external-client",
      title: "ZX1 packaged external client",
      version: "0.1.0",
    },
    reconnect: { maxAttempts: 2, minDelayMs: 25, maxDelayMs: 50 },
  });
  const thread = (await external.request("thread/start", {})).thread;
  const firstCompleted = deferred<void>();
  external.onNotification("turn/completed", ({ threadId }) => {
    if (threadId === thread.id) firstCompleted.resolve();
  });
  const running = await external.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "!shell sleep 3" }],
    clientUserMessageId: "zx1-packaged-windowless",
  });
  await writeControl({
    phase: "turn-started",
    threadId: thread.id,
    turnId: running.turn.id,
  });

  await waitForResult("window-closed");
  assert.equal(external.connected, true);
  await within(firstCompleted.promise, 15_000);
  await waitForResult("renderer-read");

  const secondCompleted = deferred<void>();
  external.onNotification("turn/completed", ({ threadId, turn }) => {
    if (threadId === thread.id && turn.id !== running.turn.id) {
      secondCompleted.resolve();
    }
  });
  await external.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "continued after renderer reopen" }],
    clientUserMessageId: "zx1-packaged-after-reopen",
  });
  await within(secondCompleted.promise, 10_000);
  const read = await external.request("thread/read", {
    threadId: thread.id,
    includeTurns: true,
  });
  assert.equal(read.thread.turns.length, 2);

  const secondInstance = spawn(
    packaged.executable,
    [`--user-data-dir=${userDataDirectory}`],
    { env: environment, stdio: "ignore" },
  );
  await waitForExit(secondInstance, 10_000);
  assert.equal(await readFile(descriptorPath, "utf8"), descriptorSource);
  assert.equal(external.connected, true);

  const externalClosed = deferred<void>();
  external.onStatus((status) => {
    if (status.type === "closed") externalClosed.resolve();
  });
  await writeControl({ phase: "quit", threadId: thread.id });
  const exit = await waitForExit(application, 20_000);
  assert.equal(exit.code, 0, `Packaged ZenX failed:\n${applicationLogs}`);
  await within(externalClosed.promise, 5_000);
  await assert.rejects(stat(descriptorPath), { code: "ENOENT" });
  await assert.rejects(stat(descriptor.authentication.tokenFile), {
    code: "ENOENT",
  });

  const journal = await readJournalText(zenDataDirectory);
  assert.equal(journal.includes(bearerToken), false);
  assert.equal(journal.includes(descriptor.url), false);
  assert.equal(descriptorSource.includes(bearerToken), false);
  assert.equal(applicationLogs.includes(bearerToken), false);
  console.log(
    JSON.stringify({
      ok: true,
      packagedArtifact: packaged.packagedArtifact,
      threadId: thread.id,
      windowlessTurnId: running.turn.id,
      descriptorPath,
    }),
  );
} finally {
  external?.close();
  if (application !== undefined && application.exitCode === null) {
    application.kill("SIGTERM");
    try {
      await waitForExit(application, 5_000);
    } catch {
      application.kill("SIGKILL");
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function packageApplication(): Promise<{
  executable: string;
  packagedArtifact: string;
}> {
  const output = await run(
    process.execPath,
    [path.join(zenxDirectory, "scripts", "package-zenx-portable.mjs"), "--app"],
    { cwd: zenxDirectory, maxBuffer: 20 * 1024 * 1024 },
  );
  const start = output.stdout.lastIndexOf("\n{");
  const source = output.stdout.slice(start < 0 ? 0 : start + 1);
  const value = JSON.parse(source) as {
    executable?: unknown;
    packagedArtifact?: unknown;
  };
  if (
    typeof value.executable !== "string" ||
    typeof value.packagedArtifact !== "string"
  ) {
    throw new Error("ZenX packaging did not return its executable");
  }
  return {
    executable: value.executable,
    packagedArtifact: value.packagedArtifact,
  };
}

function fakeHostProfile(): Record<string, unknown> {
  return {
    version: 1,
    onboardingComplete: true,
    provider: { type: "fake", displayName: "Local demo" },
    defaultModel: "fake",
    titleModel: "fake",
    models: ["fake"],
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
  };
}

async function writeControl(value: Record<string, unknown>): Promise<void> {
  await writeFile(controlPath, `${JSON.stringify(value)}\n`, "utf8");
}

async function waitForResult(phase: string): Promise<void> {
  await waitFor(async () => {
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8")) as {
        ok?: unknown;
        phase?: unknown;
      };
      return result.ok === true && result.phase === phase;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }, `packaged result phase ${phase}`);
}

async function readJournalText(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map(
          async (entry) => await readFile(path.join(directory, entry), "utf8"),
        ),
    )
  ).join("\n");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (application?.exitCode !== null && application?.exitCode !== undefined) {
      throw new Error(
        `Packaged ZenX exited before ${label} (${String(application.exitCode)}):\n${applicationLogs}`,
      );
    }
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}:\n${applicationLogs}`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await within(
    new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    timeoutMs,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for smoke event")),
        timeoutMs,
      ),
    ),
  ]);
}

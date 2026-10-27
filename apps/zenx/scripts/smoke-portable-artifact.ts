import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileTraceStore } from "../../../src/trace.js";
import {
  readZenXConnectionDescriptor,
  ZenXProtocolClient,
  type Turn,
} from "../src/protocol-client/index.js";

/** Exercises existing app hooks and protocol against supplied bytes; never rebuilds or patches. */
export async function smokePortableArtifact(options: {
  artifactDirectory: string;
}) {
  const artifactDirectory = await realpath(options.artifactDirectory);
  const executable = path.join(artifactDirectory, portableExecutable());
  assert.equal((await stat(executable)).isFile(), true);
  const fixture = await mkdtemp(path.join(os.tmpdir(), "zenx-delivery-smoke-"));
  const userData = path.join(fixture, "user-data");
  const coreData = path.join(fixture, "core-data");
  const workspace = path.join(fixture, "workspace");
  for (const directory of [
    userData,
    coreData,
    workspace,
    path.join(fixture, "home"),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(userData, "host-profile.json"),
    JSON.stringify(fakeHostProfile()),
    { mode: 0o600 },
  );
  const paths = { executable, fixture, userData, coreData, workspace };
  let application: RunningApplication | undefined;
  let safelyStopped = true;
  try {
    safelyStopped = false;
    application = await launch(paths);
    const client = application.client;
    const { thread } = await within(
      client.request("thread/start", {
        cwd: workspace,
        model: "fake",
        approvalPolicy: "never",
      }),
      15_000,
      "create synthetic Thread",
    );
    application.threadId = thread.id;
    let streamedDeltas = 0;
    const stopObserving = client.onNotification(
      "item/agentMessage/delta",
      ({ threadId, delta }) => {
        if (threadId === thread.id && delta.length > 0) streamedDeltas++;
      },
    );
    const echo = await completeTurn(
      client,
      thread.id,
      "portable artifact synthetic echo",
    );
    assert.equal(echo.status, "completed");
    assert.ok(streamedDeltas > 0, "No real streamed notifications arrived");
    stopObserving();
    await confirmRenderer(application, thread.id, echo.id);

    const success = await completeTurn(
      client,
      thread.id,
      "!shell echo portable-artifact-ok",
    );
    assert.ok(
      success.items.some(
        (item) =>
          item.type === "commandExecution" &&
          item.status === "completed" &&
          item.exitCode === 0 &&
          item.aggregatedOutput?.includes("portable-artifact-ok"),
      ),
      "Packaged shell success was not observed",
    );
    const failure = await completeTurn(client, thread.id, "!shell exit 7");
    assert.ok(
      failure.items.some(
        (item) =>
          item.type === "commandExecution" &&
          item.status === "failed" &&
          item.exitCode === 7,
      ),
      "Packaged shell failure was not observed",
    );
    await cancelRunningShell(client, thread.id, workspace);
    const beforeRestart = await within(
      client.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      }),
      15_000,
      "settled Thread read",
    );
    assert.equal(beforeRestart.thread.turns.length, 4);
    const beforeIds = beforeRestart.thread.turns.map((turn) => turn.id);
    await quit(application);
    application = undefined;
    safelyStopped = true;
    const traceIds = await readTraceIds(coreData, thread.id);

    safelyStopped = false;
    application = await launch(paths);
    application.threadId = thread.id;
    const cold = await within(
      application.client.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      }),
      15_000,
      "cold Thread read",
    );
    assert.deepEqual(
      cold.thread.turns.map((turn) => turn.id),
      beforeIds,
      "Cold read changed Turn identities",
    );
    assert.deepEqual(
      cold.thread.turns.map((turn) => turn.status),
      beforeRestart.thread.turns.map((turn) => turn.status),
      "Cold read changed settled Turn status",
    );
    // The existing hook reads this completed Turn. No new input/effect is replayed.
    await confirmRenderer(application, thread.id, echo.id);
    await quit(application);
    application = undefined;
    safelyStopped = true;
    assert.deepEqual(
      await readTraceIds(coreData, thread.id),
      traceIds,
      "Cold read changed existing Trace records",
    );
    return {
      schemaVersion: 1,
      ok: true,
      syntheticOnly: true,
      launchMode: "ordinary-bytes-existing-external-zas-hook",
      runner: { platform: process.platform, arch: process.arch },
      checks: [
        "isolated-electron-and-core-profiles",
        "streamed-fake-turn",
        "shell-success",
        "shell-failure",
        "shell-cancel",
        "window-close-reopen-renderer-read",
        "offline-trace-artifact-integrity",
        "graceful-quit",
        "cold-restart-read",
      ],
      turns: beforeIds.length,
      traceRecords: traceIds.length,
      notCovered: [
        "visual-interaction",
        "attachments",
        "queued-recovery",
        "native-computer-permissions",
        "launchservices-environment",
        "production-credentials",
      ],
    };
  } finally {
    if (application !== undefined) {
      try {
        await quit(application);
        safelyStopped = true;
      } catch {
        application.client.close();
        // Only the exact owned child; failure never becomes successful acceptance.
        if (
          application.child.exitCode === null &&
          application.child.signalCode === null
        )
          application.child.kill("SIGTERM");
        await within(
          application.exited,
          10_000,
          "failed smoke process cleanup",
        ).catch(() => undefined);
      }
    }
    // Do not remove data beneath a possibly-live Host after unconfirmed shutdown.
    if (safelyStopped) await rm(fixture, { recursive: true, force: true });
  }
}

export function portableExecutable(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return "ZenX.app/Contents/MacOS/ZenX";
  if (platform === "win32") return "ZenX.exe";
  throw new Error(
    "Portable delivery smoke currently requires native macOS or Windows",
  );
}

export function fakeHostProfile() {
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

/** Never pass inherited provider credentials, debugger hooks or real profile roots. */
export function syntheticEnvironment(
  fixture: string,
  coreData: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XAUTHORITY",
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    HOME: path.join(fixture, "home"),
    USERPROFILE: path.join(fixture, "home"),
    APPDATA: path.join(fixture, "app-data"),
    LOCALAPPDATA: path.join(fixture, "local-app-data"),
    XDG_CONFIG_HOME: path.join(fixture, "config"),
    XDG_CACHE_HOME: path.join(fixture, "cache"),
    XDG_DATA_HOME: path.join(fixture, "data"),
    TMPDIR: fixture,
    TMP: fixture,
    TEMP: fixture,
    ZENX_DATA_DIR: coreData,
  };
}

interface LaunchPaths {
  executable: string;
  fixture: string;
  userData: string;
  coreData: string;
  workspace: string;
}
interface RunningApplication {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  client: ZenXProtocolClient;
  descriptorPath: string;
  tokenPath: string;
  controlPath: string;
  resultPath: string;
  threadId?: string;
}

async function launch(paths: LaunchPaths): Promise<RunningApplication> {
  const { executable, fixture, userData, coreData, workspace } = paths;
  const acceptance = await mkdtemp(path.join(fixture, "acceptance-"));
  const configPath = path.join(acceptance, "config.json");
  const controlPath = path.join(acceptance, "control.json");
  const resultPath = path.join(acceptance, "result.json");
  await writeFile(configPath, JSON.stringify({ controlPath, resultPath }), {
    mode: 0o600,
  });
  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd: workspace,
    env: {
      ...syntheticEnvironment(fixture, coreData),
      ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG: configPath,
    },
    // No raw application logs, credentials or synthetic Trace enter CI artifacts.
    stdio: "ignore",
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  void exited.catch(() => undefined);
  let client: ZenXProtocolClient | undefined;
  try {
    const descriptorPath = path.join(userData, "runtime", "app-server.json");
    await waitFor(
      async () => {
        assertAlive(child);
        return exists(descriptorPath);
      },
      120_000,
      "packaged Host descriptor",
    );
    const descriptor = await readZenXConnectionDescriptor(descriptorPath);
    const tokenPath = descriptor.authentication.tokenFile;
    const relativeToken = path.relative(
      await realpath(userData),
      await realpath(tokenPath),
    );
    assert.ok(
      relativeToken !== "" &&
        !path.isAbsolute(relativeToken) &&
        relativeToken.split(path.sep)[0] !== "..",
      "Token escaped the synthetic profile",
    );
    client = await within(
      ZenXProtocolClient.connect({
        url: descriptor.url,
        bearerTokenFile: tokenPath,
        clientInfo: {
          name: "portable-artifact-smoke",
          title: "Synthetic portable artifact acceptance",
          version: "1",
        },
        reconnect: { maxAttempts: 1, minDelayMs: 25, maxDelayMs: 25 },
      }),
      15_000,
      "packaged protocol connection",
    );
    return {
      child,
      exited,
      client,
      descriptorPath,
      tokenPath,
      controlPath,
      resultPath,
    };
  } catch (error) {
    client?.close();
    // The existing acceptance hook fails closed and quits when its phase expires.
    // Retain the synthetic profile if that ordinary lifecycle cannot be confirmed.
    await within(exited, 70_000, "failed startup acceptance shutdown").catch(
      async () => {
        if (
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        )
          child.kill("SIGTERM");
        await within(
          exited,
          10_000,
          "failed startup termination remains unconfirmed",
        );
      },
    );
    throw error;
  }
}

async function confirmRenderer(
  application: RunningApplication,
  threadId: string,
  turnId: string,
) {
  await writeControl(application.controlPath, {
    phase: "turn-started",
    threadId,
    turnId,
  });
  await waitFor(
    async () => {
      assertAlive(application.child);
      try {
        const result = JSON.parse(
          await readFile(application.resultPath, "utf8"),
        ) as Record<string, unknown>;
        return (
          result.ok === true &&
          result.phase === "renderer-read" &&
          result.threadId === threadId &&
          result.turnId === turnId
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    30_000,
    "existing window-close/reopen renderer acceptance",
  );
  assert.equal(
    application.client.connected,
    true,
    "Closing/reopening the window lost the Host",
  );
}

async function quit(application: RunningApplication) {
  assertAlive(application.child);
  if (application.threadId === undefined)
    throw new Error(
      "Synthetic Thread unavailable for ordinary acceptance Quit",
    );
  await writeControl(application.controlPath, {
    phase: "quit",
    threadId: application.threadId,
  });
  const exit = await within(application.exited, 30_000, "ordinary app Quit");
  application.client.close();
  assert.equal(exit.code, 0, "Packaged app Quit did not exit successfully");
  assert.equal(exit.signal, null, "Packaged app required forced termination");
  assert.equal(
    await exists(application.descriptorPath),
    false,
    "Quit retained the Host descriptor",
  );
  assert.equal(
    await exists(application.tokenPath),
    false,
    "Quit retained the Host token",
  );
}

async function readTraceIds(
  coreData: string,
  threadId: string,
): Promise<string[]> {
  // Existing read-only API, only after the exact packaged app has gracefully stopped.
  const trace = await new FileTraceStore(path.join(coreData, "trace")).read(
    threadId,
    { verifyArtifacts: true },
  );
  assert.equal(trace.completeness, "complete");
  assert.equal(trace.artifactVerification, "verified");
  assert.equal(trace.issues.length, 0);
  assert.ok(trace.records.length > 0, "Packaged Trace has no records");
  return trace.records.map((record) => record.id);
}

async function cancelRunningShell(
  client: ZenXProtocolClient,
  threadId: string,
  workspace: string,
) {
  // commandExecution/outputDelta is emitted from the completed tool result,
  // not live output. Observe only our owned marker to prove actual dispatch.
  const marker = path.join(workspace, "portable-cancel-ready");
  assert.equal(await exists(marker), false);
  const interrupted = observeTurnCompletion(client, threadId);
  try {
    const started = await within(
      client.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text:
              process.platform === "win32"
                ? "!shell echo portable-cancel-started > portable-cancel-ready && ping -n 31 127.0.0.1"
                : "!shell echo portable-cancel-started > portable-cancel-ready && sleep 30",
          },
        ],
        clientUserMessageId: "portable-cancel",
      }),
      15_000,
      "start synthetic cancellation Turn",
    );
    await waitFor(
      () => exists(marker),
      15_000,
      "owned packaged shell dispatch marker",
    );
    assert.equal(
      (await readFile(marker, "utf8")).trim(),
      "portable-cancel-started",
    );
    await within(
      client.request("turn/interrupt", { threadId, turnId: started.turn.id }),
      15_000,
      "interrupt synthetic shell",
    );
    assert.equal(
      (await within(interrupted.promise, 15_000, "cancelled Turn")).status,
      "interrupted",
    );
  } finally {
    interrupted.dispose();
  }
}

export async function writeControl(
  file: string,
  value: Record<string, unknown>,
) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

function assertAlive(child: ChildProcess) {
  if (child.pid === undefined)
    throw new Error("Packaged executable failed to spawn");
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error("Packaged app exited before acceptance completed");
}

function observeTurnCompletion(client: ZenXProtocolClient, threadId: string) {
  const completion = deferred<Turn>();
  const dispose = client.onNotification("turn/completed", (event) => {
    if (event.threadId === threadId) completion.resolve(event.turn);
  });
  return { promise: completion.promise, dispose };
}

async function completeTurn(
  client: ZenXProtocolClient,
  threadId: string,
  text: string,
): Promise<Turn> {
  const completion = observeTurnCompletion(client, threadId);
  try {
    await within(
      client.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
      }),
      15_000,
      "synthetic Turn admission",
    );
    return await within(
      completion.promise,
      15_000,
      "synthetic Turn completion",
    );
  } finally {
    completion.dispose();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function waitFor(
  check: () => Promise<boolean>,
  timeout: number,
  label: string,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function within<T>(
  promise: Promise<T>,
  timeout: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: smoke-portable-artifact.ts <existing-artifact-directory>",
    );
  console.log(
    JSON.stringify(
      await smokePortableArtifact({ artifactDirectory: process.argv[2]! }),
    ),
  );
}

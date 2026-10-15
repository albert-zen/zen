/** Single fresh-profile macOS observation. No browser acceptance or input. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  Rpc,
  page,
  startNative,
  stopOwnedChild,
} from "./browser-parallel-input-smoke.js";
import {
  InspectDiagnosticTransport,
  InspectEvidenceJournal,
  inspectSourceSha256,
  instrumentInspectNative,
  observeFirstInspect,
  recordValue,
  timedInspectExpression,
  type InspectLatencyReport,
} from "./browser-inspect-latency.js";

const delay = async (ms: number) =>
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
async function poll<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = await read(); // Unknown/error is terminal, never swallowed.
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("Owned diagnostic setup deadline");
}
export async function confirmInspectChildExit(
  child: ChildProcess,
): Promise<void> {
  await stopOwnedChild(child);
  await poll(async () =>
    child.exitCode !== null || child.signalCode !== null ? true : undefined,
  );
}

export async function main(): Promise<void> {
  const executable = process.env.ZENX_USER_BROWSER_EXECUTABLE;
  const artifactRoot = process.env.ZENX_INSPECT_ARTIFACT_DIR;
  const head = process.env.ZENX_DIAGNOSTIC_HEAD;
  const tree = process.env.ZENX_DIAGNOSTIC_TREE;
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.CI, "1");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
  assert(executable && path.isAbsolute(executable));
  assert(artifactRoot && path.isAbsolute(artifactRoot));
  assert(head && /^[a-f0-9]{40}$/.test(head));
  assert(tree && /^[a-f0-9]{40}$/.test(tree));
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-inspect-"));
  const profile = path.join(directory, "owned-profile");
  const observation: InspectLatencyReport = {
    scope: "owned first-inspect replica; not acceptance",
    sourceSha256: inspectSourceSha256,
    classification: "setup-failed",
    stages: [],
  };
  const axEvents: Record<string, unknown>[] = [];
  const cleanupErrors: string[] = [];
  const report: Record<string, unknown> = {
    schema: 1,
    head,
    tree,
    profileId: randomUUID(),
    observation,
    axEvents,
    wrapperSha256: createHash("sha256")
      .update(timedInspectExpression)
      .digest("hex"),
    cleanupConfirmed: false,
    cleanupErrors,
    osPermissionRequested: false,
    freshProfiles: 1,
    idleTitleCooldownMs: 250,
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(page(request.url === "/agent" ? "agent" : "user"));
  });
  let browser: ChildProcess | undefined;
  let native: Awaited<ReturnType<typeof startNative>> | undefined;
  const setupRpcs: Rpc[] = [];
  let socket: WebSocket | undefined;
  let transport: InspectDiagnosticTransport | undefined;
  let stopAx: (() => void) | undefined;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const progressPath = path.join(artifactRoot, "first-inspect-progress.ndjson");
  const journal = new InspectEvidenceJournal({
    head,
    tree,
    append: (line) => appendFile(progressPath, line),
    emit: (line) => console.log(line),
  });
  try {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(progressPath, "", { flag: "wx" });
    journal.record("manifest", report);
    await journal.flush();
    await mkdir(profile);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    report.phase = "native-compile";
    native = await startNative(directory, (source) => {
      assert(source.includes("let idleTitleCooldown = 0.25"));
      report.nativeSourceSha256 = createHash("sha256")
        .update(source)
        .digest("hex");
      const instrumented = instrumentInspectNative(source);
      report.instrumentedNativeSha256 = createHash("sha256")
        .update(instrumented)
        .digest("hex");
      return instrumented;
    });
    const lines = createInterface({ input: native.child.stdout! });
    lines.on("line", (line) => {
      let message: Record<string, unknown> | undefined;
      try {
        message = recordValue(JSON.parse(line));
      } catch {
        return;
      }
      const event = recordValue(message?.result);
      if (
        message?.id !== -1 ||
        !event ||
        !["ax-title-start", "ax-title-end"].includes(String(event.kind))
      )
        return;
      if (axEvents.length >= 512) {
        report.axEventsDropped = Number(report.axEventsDropped ?? 0) + 1;
        return;
      }
      const measured = {
        kind: event.kind,
        atUnixMs: event.atUnixMs,
        ...(event.kind === "ax-title-end"
          ? { elapsedMs: event.elapsedMs }
          : {}),
      };
      axEvents.push(measured);
      journal.record("ax-title", measured);
    });
    stopAx = () => lines.close();
    report.phase = "native-readiness";
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      native.ready,
      new Promise<never>((_resolve, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("Native readiness deadline")),
          15_000,
        );
      }),
    ]).finally(() => {
      if (readyTimer) clearTimeout(readyTimer);
    });
    assert.equal(
      ready.axTrusted,
      true,
      "Accessibility unavailable; no permission requested",
    );
    report.nativePid = ready.pid;
    report.phase = "browser-launch";
    journal.record("setup", { phase: report.phase });
    await journal.flush();
    browser = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--force-renderer-accessibility",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1000,720",
        "--window-position=300,180",
        `${origin}/user`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let launchError = false;
    browser.on("error", () => {
      launchError = true;
    });
    // Drain owned stderr; do not publish raw browser messages/URLs.
    browser.stderr!.on("data", () => undefined);
    assert(browser.pid);
    report.browserPid = browser.pid;
    const port = await poll(async () => {
      assert(
        !launchError &&
          browser!.exitCode === null &&
          browser!.signalCode === null,
      );
      try {
        const candidate = (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split(/\r?\n/u)[0];
        return /^\d+$/.test(candidate ?? "") ? candidate : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    });
    const endpoint = `http://127.0.0.1:${port}`;
    const getJson = async (route: string) => {
      const response = await fetch(`${endpoint}/${route}`, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      assert(response.ok);
      return (await response.json()) as unknown;
    };
    report.phase = "owned-endpoint";
    const version = recordValue(await getJson("json/version"));
    assert(typeof version?.webSocketDebuggerUrl === "string");
    assert(
      typeof version.Browser === "string" &&
        /^(Chrome|Chromium)\/[0-9.]+$/.test(version.Browser),
    );
    report.browser = version.Browser;
    const socketUrl = new URL(version.webSocketDebuggerUrl);
    assert.equal(socketUrl.protocol, "ws:");
    assert.equal(socketUrl.hostname, "127.0.0.1");
    assert.equal(socketUrl.port, port);
    assert(
      !socketUrl.username &&
        !socketUrl.password &&
        !socketUrl.search &&
        !socketUrl.hash &&
        /^\/devtools\/browser\/[^/]+$/.test(socketUrl.pathname),
    );
    report.phase = "user-fixture-setup";
    const fixtureUserTitle = /<title>([^<]+)<\/title>/.exec(page("user"))?.[1];
    assert(fixtureUserTitle);
    const user = await poll(async () => {
      const targets = await getJson("json/list");
      assert(Array.isArray(targets));
      return targets
        .map(recordValue)
        .find(
          (target) =>
            target?.type === "page" &&
            target.url === `${origin}/user` &&
            target.title === fixtureUserTitle,
        );
    });
    assert(
      typeof user.id === "string" &&
        typeof user.title === "string" &&
        typeof user.webSocketDebuggerUrl === "string",
    );
    const userSocket = new URL(user.webSocketDebuggerUrl);
    assert.equal(userSocket.hostname, "127.0.0.1");
    assert.equal(userSocket.port, port);
    assert.equal(userSocket.protocol, "ws:");
    assert(
      !userSocket.username &&
        !userSocket.password &&
        !userSocket.search &&
        !userSocket.hash &&
        /^\/devtools\/page\/[^/]+$/.test(userSocket.pathname),
    );
    const userRpc = await Rpc.connect(userSocket.href);
    setupRpcs.push(userRpc);
    await poll(async () =>
      (await userRpc.evaluate<boolean>(
        "Boolean(window.fixture && document.querySelector('#user-input'))",
      ))
        ? true
        : undefined,
    );
    await journal.flush();
    await userRpc.evaluate("document.querySelector('#user-input').focus()");
    const browserRpc = await Rpc.connect(socketUrl.href);
    setupRpcs.push(browserRpc);
    await journal.flush();
    await browserRpc.send("Target.activateTarget", { targetId: user.id });
    await journal.flush();
    await native.call("activateBrowser", {
      pid: browser.pid,
      title: user.title,
    });
    await poll(async () =>
      (await native!.call("snapshot")).pid === browser!.pid ? true : undefined,
    );
    const guarded = await native.call("guard", {
      pid: browser.pid,
      title: fixtureUserTitle,
    });
    assert.equal(guarded.pid, browser.pid);
    assert.equal(guarded.drift, false);
    // No snapshot polling during the measured period: it would create extra AX work.
    socket = new WebSocket(socketUrl.href, {
      handshakeTimeout: 5_000,
      maxPayload: 1_048_576,
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
      socket!.once("close", () => reject(new Error("closed before open")));
    });
    await journal.flush();
    transport = new InspectDiagnosticTransport(socket, (event) =>
      journal.record("transport", event),
    );
    report.events = transport.events;
    report.phase = "measured-startup-and-first-inspect";
    report.measuredStartedAtUnixMs = Date.now();
    loop.enable();
    await observeFirstInspect({
      transport,
      ownedPageUrl: `${origin}/agent`,
      listOwnedTargets: () => getJson("json/list"),
      report: observation,
      checkpoint: () => journal.flush(),
      progress: (value) => journal.record("observation", value),
    });
    await journal.flush();
  } catch {
    report.setupError = "Owned setup failed; no operation replayed";
  } finally {
    report.measuredEndedAtUnixMs = Date.now();
    loop.disable();
    const ms = (value: number) =>
      Number.isFinite(value) ? value / 1_000_000 : 0;
    report.nodeEventLoop = {
      meanMs: ms(loop.mean),
      maxMs: ms(loop.max),
      p99Ms: ms(loop.percentile(99)),
    };
    if (transport) report.eventsDropped = transport.droppedEvents;
    // Commit all already-observed evidence BEFORE any cleanup can stall.
    journal.record("before-cleanup", {
      observation,
      nodeEventLoop: report.nodeEventLoop,
      axEvents,
      phase: report.phase,
    });
    await journal.flush().catch(() => {
      report.evidenceError = journal.failure;
    });
    // Stop observation before cleanup. Existing evidence and unknown classification
    // remain immutable even if terminating resources causes a late transport event.
    transport?.dispose();
    socket?.terminate();
    for (const rpc of setupRpcs) rpc.close();
    journal.record("cleanup-started", {});
    if (native)
      await native
        .call("clear")
        .catch(() => cleanupErrors.push("native-clear-failed"));
    if (browser)
      await confirmInspectChildExit(browser).catch(() =>
        cleanupErrors.push("browser-exit-unconfirmed"),
      );
    if (native) {
      await native
        .close()
        .catch(() => cleanupErrors.push("native-close-failed"));
      await confirmInspectChildExit(native.child).catch(() =>
        cleanupErrors.push("native-exit-unconfirmed"),
      );
    }
    stopAx?.();
    if (server.listening) {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    }
    if (cleanupErrors.length === 0)
      await rm(directory, { recursive: true, force: true }).catch(() =>
        cleanupErrors.push("owned-directory-removal-failed"),
      );
    if (cleanupErrors.length > 0) report.ownedDirectoryRetained = true;
    report.cleanupConfirmed = cleanupErrors.length === 0;
    const completed = axEvents
      .filter((event) => event.kind === "ax-title-end")
      .map((event) => Number(event.elapsedMs));
    report.axSummary = {
      callsStarted: axEvents.filter((event) => event.kind === "ax-title-start")
        .length,
      callsCompleted: completed.length,
      totalMs: completed.reduce((sum, value) => sum + value, 0),
      maxMs: completed.length ? Math.max(...completed) : 0,
    };
    journal.record("cleanup-finished", {
      cleanupConfirmed: report.cleanupConfirmed,
      cleanupErrors,
    });
    await journal.flush().catch(() => {
      report.evidenceError = journal.failure;
    });
    // Console evidence survives an artifact-storage error too.
    console.log(JSON.stringify(report, null, 2));
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      path.join(artifactRoot, "first-inspect.json"),
      JSON.stringify(report, null, 2),
    );
  }
  if (
    cleanupErrors.length ||
    report.setupError ||
    report.evidenceError ||
    observation.classification !== "not-reproduced" ||
    observation.browserProbe?.status !== "success"
  )
    process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();

/** One-shot owned macOS focus experiment. Never ordinary acceptance. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Rpc,
  startNative,
  stopOwnedChild,
  type NativeState,
} from "./browser-parallel-input-smoke.js";

type Operation = "capture-only" | "insert-only";
interface PageState {
  hasFocus: boolean;
  visibility: string;
  activeElement: string;
  value: string;
  focusEvents: string[];
  visibilityEvents: string[];
}
interface Snapshot {
  user: PageState;
  agent: PageState;
  native: NativeState;
}
const delay = async (ms: number) =>
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
const stateScript = `({hasFocus:document.hasFocus(),visibility:document.visibilityState,activeElement:document.activeElement?.id||'',value:document.querySelector('input').value,focusEvents:[...window.focusEvents],visibilityEvents:[...window.visibilityEvents]})`;

export interface FocusObservation {
  operation: Operation;
  status: "started" | "observed" | "stopped-after-error";
  commandStatus: "not-dispatched" | "dispatch-requested" | "replied";
  before?: Snapshot;
  after: Snapshot[];
  focusHistoryChanged: boolean;
  agentFocusHistoryChanged: boolean;
  nativeOwnershipChanged: boolean;
  error?: string;
}

// Test this exact dispatch path. A rejected/unknown command immediately leaves
// the experiment; preserve evidence already read but never read/replay again.
export async function observeFocusOperation(options: {
  operation: Operation;
  sentinelPid: number;
  read: () => Promise<Snapshot>;
  send: (
    role: "user" | "agent",
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  wait: (milliseconds: number) => Promise<void>;
  record?: (observation: FocusObservation) => void;
}) {
  const observation: FocusObservation = {
    operation: options.operation,
    status: "started",
    commandStatus: "not-dispatched",
    after: [],
    focusHistoryChanged: false,
    agentFocusHistoryChanged: false,
    nativeOwnershipChanged: false,
  };
  const record = () => options.record?.(structuredClone(observation));
  record();
  try {
    const before = await options.read();
    observation.before = before;
    record();
    assert.equal(before.native.pid, options.sentinelPid);
    assert.equal(before.native.sentinelFocused, true);
    assert.equal(before.native.drift, false);
    assert.equal(before.user.hasFocus, false);
    assert.equal(before.user.visibility, "visible");
    assert.equal(before.user.activeElement, "user-input");
    assert.equal(before.agent.visibility, "hidden");
    observation.commandStatus = "dispatch-requested";
    record();
    if (options.operation === "capture-only") {
      const result = await options.send("agent", "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      assert(typeof result.data === "string");
      assert(result.data.length > 0, "Capture did not return image data");
      // The image is disposable and deliberately absent from all reports.
    } else {
      await options.send("user", "Input.insertText", { text: "SYNTHETIC" });
    }
    observation.commandStatus = "replied";
    record();
    const readAfter = async () => {
      const sample = await options.read();
      observation.after.push(sample);
      observation.focusHistoryChanged ||=
        JSON.stringify(sample.user.focusEvents) !==
        JSON.stringify(before.user.focusEvents);
      observation.agentFocusHistoryChanged ||=
        JSON.stringify(sample.agent.focusEvents) !==
        JSON.stringify(before.agent.focusEvents);
      observation.nativeOwnershipChanged ||=
        sample.native.pid !== options.sentinelPid ||
        sample.native.sentinelFocused !== true ||
        sample.native.drift;
      record();
    };
    await readAfter();
    await options.wait(200); // Observe only already-issued events, never replay.
    await readAfter();
    observation.status = "observed";
    record();
    return observation;
  } catch (error) {
    observation.status = "stopped-after-error";
    observation.error = error instanceof Error ? error.message : String(error);
    record();
    throw error;
  }
}

async function poll<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = await read(); // Rejection is terminal; no catch/retry.
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error("Owned diagnostic setup did not settle");
}

async function confirmExit(child: ChildProcess): Promise<void> {
  await stopOwnedChild(child);
  await poll(async () =>
    child.exitCode !== null || child.signalCode !== null ? true : undefined,
  );
}

async function main(): Promise<void> {
  const operation = process.env.ZENX_FOCUS_OPERATION;
  const executable = process.env.ZENX_USER_BROWSER_EXECUTABLE;
  const artifactRoot = process.env.ZENX_FOCUS_ARTIFACT_DIR;
  const head = process.env.ZENX_DIAGNOSTIC_HEAD;
  const tree = process.env.ZENX_DIAGNOSTIC_TREE;
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.CI, "1");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
  assert(operation === "capture-only" || operation === "insert-only");
  assert(executable && path.isAbsolute(executable));
  assert(artifactRoot && path.isAbsolute(artifactRoot));
  assert(head && /^[a-f0-9]{40}$/.test(head));
  assert(tree && /^[a-f0-9]{40}$/.test(tree));
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-focus-"));
  const profile = path.join(directory, "owned-profile");
  await mkdir(profile);
  const nonce = randomUUID();
  const title = `ZenX Focus USER ${nonce}`;
  const trace: Record<string, unknown>[] = [];
  let phase = "setup";
  const report: Record<string, unknown> = {
    schema: 1,
    scope: "owned synthetic macOS focus diagnostic; not acceptance",
    operation,
    head,
    tree,
    profileId: nonce,
    trace,
  };
  const connections: Rpc[] = [];
  const connect = async (role: string, url: string) => {
    const rpc = await Rpc.connect(url);
    connections.push(rpc);
    const original = rpc.send.bind(rpc);
    rpc.send = async (method, params = {}) => {
      const started = performance.now();
      trace.push({ role, method, phase, kind: "send", at: started });
      try {
        const result = await original(method, params);
        trace.push({
          role,
          method,
          phase,
          kind: "reply",
          at: performance.now(),
          elapsedMs: performance.now() - started,
        });
        return result;
      } catch (error) {
        trace.push({
          role,
          method,
          phase,
          kind: "rejected-stop",
          at: performance.now(),
        });
        throw error;
      }
    };
    return rpc;
  };
  const server = createServer((request, response) => {
    const user = request.url === "/user";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(
      `<!doctype html><title>${user ? title : `ZenX Focus AGENT ${nonce}`}</title><input id="${user ? "user" : "agent"}-input"><script>window.focusEvents=[];window.visibilityEvents=[];for(const type of ['focus','blur'])window.addEventListener(type,event=>{if(event.target===window)focusEvents.push(type)});document.addEventListener('visibilitychange',()=>visibilityEvents.push(document.visibilityState));</script>`,
    );
  });
  let browser: ChildProcess | undefined;
  let native: Awaited<ReturnType<typeof startNative>> | undefined;
  let failed = false;
  const cleanupErrors: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    native = await startNative(directory);
    const ready = await native.ready;
    assert.equal(
      ready.axTrusted,
      true,
      "Accessibility unavailable; no permission requested",
    );
    report.nativePid = ready.pid;
    browser = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--force-renderer-accessibility",
        "--no-first-run",
        "--no-default-browser-check",
        `${origin}/user`,
      ],
      { stdio: "ignore" },
    );
    let launchError: Error | undefined;
    browser.on("error", (error) => {
      launchError = error;
    });
    const port = await poll(async () => {
      if (launchError) throw launchError;
      assert(browser!.exitCode === null && browser!.signalCode === null);
      try {
        const value = (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split(/\r?\n/u)[0];
        return /^\d+$/.test(value ?? "") ? value : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    });
    assert(browser.pid);
    report.browserPid = browser.pid;
    const getJson = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/${route}`, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      assert(response.ok);
      return response.json();
    };
    const version = await getJson("json/version");
    report.browserVersion = version.Browser;
    const browserRpc = await connect("browser", version.webSocketDebuggerUrl);
    const user = await poll(async () =>
      (await getJson("json/list")).find(
        (target: { url: string }) => target.url === `${origin}/user`,
      ),
    );
    const userRpc = await connect("user", user.webSocketDebuggerUrl);
    await userRpc.evaluate(
      `new Promise(resolve=>{if(document.readyState==='complete')resolve(true);else window.addEventListener('load',()=>resolve(true),{once:true})})`,
    );
    await userRpc.evaluate(`document.querySelector('#user-input').focus()`);
    const opened = await browserRpc.send("Target.createTarget", {
      url: `${origin}/agent`,
      background: true,
    });
    const agent = await poll(async () =>
      (await getJson("json/list")).find(
        (target: { id: string; url: string }) =>
          target.id === opened.targetId && target.url === `${origin}/agent`,
      ),
    );
    const agentRpc = await connect("agent", agent.webSocketDebuggerUrl);
    await agentRpc.evaluate(
      `new Promise(resolve=>{if(document.readyState==='complete')resolve(true);else window.addEventListener('load',()=>resolve(true),{once:true})})`,
    );
    const userWindow = await browserRpc.send("Browser.getWindowForTarget", {
      targetId: user.id,
    });
    const agentWindow = await browserRpc.send("Browser.getWindowForTarget", {
      targetId: agent.id,
    });
    assert.equal(userWindow.windowId, agentWindow.windowId);
    await browserRpc.send("Target.activateTarget", { targetId: user.id });
    await native.call("activateBrowser", { pid: browser.pid, title });
    await poll(async () =>
      (await native!.call("snapshot")).pid === browser!.pid ? true : undefined,
    );
    await native.call("sentinel");
    await poll(async () => {
      const state = await native!.call("snapshot");
      return state.pid === ready.pid && state.sentinelFocused === true
        ? true
        : undefined;
    });
    // Settle setup using actual renderer focus before capturing the baseline.
    // Every read is single dispatch; a rejection stops rather than being polled.
    await poll(async () =>
      !(await userRpc.evaluate<PageState>(stateScript)).hasFocus
        ? true
        : undefined,
    );
    await native.call("guard", {
      pid: ready.pid,
      title: "ZenX Parallel Sentinel",
    });
    phase = "single-operation";
    await observeFocusOperation({
      record: (observation) => {
        report.observation = observation;
      },
      operation,
      sentinelPid: ready.pid,
      read: async () => {
        const [userState, agentState, nativeState] = await Promise.all([
          userRpc.evaluate<PageState>(stateScript),
          agentRpc.evaluate<PageState>(stateScript),
          native!.call("snapshot"),
        ]);
        return { user: userState, agent: agentState, native: nativeState };
      },
      send: (role, method, params) =>
        (role === "user" ? userRpc : agentRpc).send(method, params),
      wait: delay,
    });
    report.status = "observed";
  } catch (error) {
    failed = true;
    report.status = "stopped-after-error";
    report.error = error instanceof Error ? error.message : String(error);
    report.failedPhase = phase;
  } finally {
    phase = "cleanup";
    for (const rpc of connections) rpc.close();
    if (browser)
      await confirmExit(browser).catch((error) =>
        cleanupErrors.push(`browser: ${String(error)}`),
      );
    if (native) {
      await native
        .close()
        .catch((error) => cleanupErrors.push(`native close: ${String(error)}`));
      await confirmExit(native.child).catch((error) =>
        cleanupErrors.push(`native exit: ${String(error)}`),
      );
    }
    if (server.listening)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    if (!cleanupErrors.length)
      await rm(directory, { recursive: true, force: true }).catch((error) =>
        cleanupErrors.push(`owned directory: ${String(error)}`),
      );
    report.cleanupErrors = cleanupErrors;
    report.cleanupConfirmed = cleanupErrors.length === 0;
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      path.join(artifactRoot, `${operation}.json`),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
  if (failed || cleanupErrors.length)
    throw new Error("Owned focus diagnostic stopped; do not replay");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();

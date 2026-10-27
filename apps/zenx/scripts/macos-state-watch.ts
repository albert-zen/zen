// Real state observation only: never changes display/lock/focus or enables global input.
import { app, BrowserWindow, powerMonitor, powerSaveBlocker } from "electron";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
} from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  bounded as bound,
  pause,
  evaluationDuration,
  claimLauncherProfile,
} from "./macos-eval-lifecycle.mjs";
import { AutomationEnvironment } from "../src/main/automation-environment.js";
import {
  MacAccessibilityDriver,
  ElectronMacComputerBackend,
  ComputerZenXCapabilityPackage,
} from "../src/main/capabilities/computer-provider.js";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";

export async function runMacosStateWatch() {
  const output = process.env.ZENX_MACOS_EVAL_DIR;
  let duration = 300000;
  try {
    if (!output)
      throw Error("Set ZENX_MACOS_EVAL_DIR to a fresh private directory");
    duration = evaluationDuration(
      "ZENX_STATE_WATCH_MS",
      process.env.ZENX_STATE_WATCH_MS,
      300000,
    );
  } catch (error) {
    console.error(String(error));
    app.exit(2);
    return;
  }
  const started = performance.now();
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error("State watch deadline reached")),
    Math.min(duration, 268000),
  );
  let scratch: string | undefined,
    fixture: ChildProcess | undefined,
    window: BrowserWindow | undefined;
  let environment: AutomationEnvironment | undefined;
  let computer: ComputerZenXCapabilityPackage | undefined;
  let cdp:
    Awaited<ReturnType<typeof connectUserBrowserCdp>>["backend"] | undefined;
  const server = createServer();
  let failed = false;
  const records: any[] = [];
  const cleanup: any = { errors: [] };
  const pending = new Set<Promise<unknown>>();
  const bounded = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return bound(promise, signal) as Promise<T>;
  };
  let source = "unavailable";
  const command = async (executable: string, args: string[]) =>
    (
      await promisify(execFile)(executable, args, {
        signal: abort.signal,
        timeout: 30000,
      })
    ).stdout.trim();
  const record = (value: any) => records.push({ time: Date.now(), ...value });
  let ready: any;
  async function flush() {
    await writeFile(
      path.join(output!, "state-watch.json"),
      JSON.stringify({ source, ready, records }, null, 2),
    );
  }
  try {
    source = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    scratch = claimLauncherProfile(output!);
    cleanup.scratch = scratch;
    app.setPath("userData", path.join(scratch, "profile"));
    app.setActivationPolicy("accessory");
    app.commandLine.appendSwitch("remote-debugging-port", "0");
    app.on("window-all-closed", () => undefined);
    if (process.env.ZENX_MACOS_EVAL_FAIL_AT === "after-profile")
      throw Error("Injected failure after profile");
    await bounded(app.whenReady(), abort.signal);
    const nativeBinary = path.join(scratch, "native-fixture"),
      displayBinary = path.join(scratch, "display-state");
    for (const [sourceFile, binary] of [
      ["macos-native-fixture.swift", nativeBinary],
      ["macos-display-state.swift", displayBinary],
    ]) {
      const content = await readFile(
        new URL(`../evals/browser-computer/${sourceFile}`, import.meta.url),
        "utf8",
      );
      const sourcePath = path.join(scratch, sourceFile!);
      await writeFile(sourcePath, content);
      record({ setupPhase: "compile-fixture", sourceFile });
      await command("/usr/bin/swiftc", [sourcePath, "-o", binary!]);
    }
    const driver = new MacAccessibilityDriver(
      path.join(scratch, "session-probe"),
    );
    environment = new AutomationEnvironment({
      platform: process.platform,
      monitor: powerMonitor,
      blocker: powerSaveBlocker,
      nativeSessionProbe: (signal) => driver.sessionState(signal),
    });
    if (typeof environment.refresh !== "function")
      throw Error(
        "This checkout lacks the native-session AutomationEnvironment API required by state watch",
      );
    record({ setupPhase: "native-session-probe" });
    await bounded(environment.refresh(), abort.signal);
    for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"])
      powerMonitor.on(event, () =>
        record({ powerMonitorEvent: event, snapshot: environment!.snapshot() }),
      );
    computer = new ComputerZenXCapabilityPackage(
      new ElectronMacComputerBackend(path.join(scratch, "computer")),
      undefined,
      false,
      undefined,
      environment,
    );
    async function invoke(name: string, args: any) {
      abort.signal.throwIfAborted();
      const start = performance.now();
      const snapshot = environment!.snapshot();
      try {
        const result: any = await bounded(
          computer!.invoke(name, {
            name,
            callId: `watch-${records.length}`,
            threadId: "owned-macos-watch",
            cwd: scratch!,
            arguments: args,
            signal: abort.signal,
          }),
          abort.signal,
        );
        record({
          name,
          args,
          snapshot,
          milliseconds: performance.now() - start,
          result,
        });
        return result;
      } catch (error) {
        record({ name, args, snapshot, error: String(error) });
        throw error;
      }
    }
    fixture = spawn(nativeBinary, [], { stdio: ["ignore", "pipe", "pipe"] });
    cleanup.childPid = fixture.pid;
    const target: any = await bounded(
      new Promise((resolve, reject) => {
        let line = "";
        fixture!.stdout!.on("data", (chunk) => {
          line += String(chunk);
          if (line.includes("\n"))
            try {
              resolve(JSON.parse(line.split("\n")[0]!));
            } catch (error) {
              reject(error);
            }
        });
        fixture!.once("error", reject);
        fixture!.once("exit", (code) =>
          reject(Error(`Native fixture exited before readiness (${code})`)),
        );
      }),
      abort.signal,
    );
    const html = `<!doctype html><title>ZenX owned state fixture</title><h1>Owned state fixture</h1><button onclick="document.querySelector('output').textContent=String(++window.clickCount)">Owned browser action</button><output>0</output><script>window.clickCount=0</script>`;
    server.on("request", (_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
    });
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }),
      abort.signal,
    );
    cleanup.port = (server.address() as any).port;
    if (process.env.ZENX_MACOS_EVAL_FAIL_AT === "after-listen")
      throw Error("Injected failure after listen");
    window = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await bounded(
      window.loadURL(`http://127.0.0.1:${cleanup.port}/`),
      abort.signal,
    );
    window.setTitle("ZenX owned state fixture");
    window.showInactive();
    const port = Number(
      (
        await readFile(
          path.join(scratch, "profile", "DevToolsActivePort"),
          "utf8",
        )
      ).split("\n")[0],
    );
    cdp = (
      await bounded(
        connectUserBrowserCdp(`http://127.0.0.1:${port}`, abort.signal),
        abort.signal,
      )
    ).backend;
    const tabs = await bounded(
      cdp.listTabs("owned-watch", abort.signal),
      abort.signal,
    );
    const tab = tabs.find((t) => t.url === `http://127.0.0.1:${cleanup.port}/`);
    if (!tab) throw Error("Exact owned CDP fixture was not found");
    const display = async () => JSON.parse(await command(displayBinary, []));
    ready = {
      ready: true,
      source,
      pid: process.pid,
      target,
      domTarget: { pid: process.pid, windowTitle: window.getTitle() },
      deadline:
        Date.now() +
        Math.max(0, Math.min(duration, 268000) - (performance.now() - started)),
      snapshot: environment.snapshot(),
      display: await display(),
    };
    await writeFile(
      path.join(output!, "ready.json"),
      JSON.stringify(ready, null, 2),
    );
    console.log(JSON.stringify(ready));
    if (process.env.ZENX_MACOS_EVAL_FAIL_AT === "after-ready")
      throw Error("Injected failure after ready");
    let previous = "",
      previousRevision: number | undefined,
      oldControl: any;
    while (!abort.signal.aborted) {
      await bounded(environment.refresh(), abort.signal);
      const snapshot = environment.snapshot(),
        actual = await display();
      record({ sample: true, snapshot, display: actual });
      const key = JSON.stringify([
        snapshot.sessionState,
        snapshot.revision,
        actual.displayAsleep,
        actual.screenLocked,
      ]);
      if (key !== previous) {
        record({ transition: { from: previous, to: key } });
        previous = key;
        if (oldControl && previousRevision !== snapshot.revision)
          await invoke("computer_set_value", {
            target,
            control: oldControl,
            value: "OLD REF MUST REJECT",
          }).then(
            () => record({ oldRefRejected: false }),
            (error) => record({ oldRefRejected: true, error: String(error) }),
          );
        previousRevision = snapshot.revision;
        try {
          let obs = await invoke("computer_inspect", { target, full: true });
          const field = obs.controls.find(
            (c: any) =>
              c.title === "Native field" && c.actions.includes("set_value"),
          );
          if (field)
            await invoke("computer_set_value", {
              target,
              control: field.selector,
              value: `状态${snapshot.sessionState}-${snapshot.revision}`,
            }).catch(() => {});
          obs = await invoke("computer_inspect", { target, full: true });
          const button = obs.controls.find(
            (c: any) =>
              c.title === "Native action" && c.actions.includes("press"),
          );
          if (button)
            await invoke("computer_press", {
              target,
              control: button.selector,
            }).catch(() => {});
          obs = await invoke("computer_inspect", { target, full: true });
          record({ nativeReadback: obs });
          oldControl = obs.controls.find(
            (c: any) =>
              c.title === "Native field" && c.actions.includes("set_value"),
          )?.selector;
        } catch (error) {
          record({ nativeError: String(error) });
        }
        if (snapshot.sessionState === "locked" || actual.screenLocked === true)
          for (const [name, args] of [
            ["computer_screenshot", { target }],
            [
              "computer_foreground_type",
              {
                target,
                bindingId: "intentionally-unbound",
                text: "MUST NOT TYPE",
              },
            ],
          ] as const)
            await invoke(name, args).then(
              () => record({ refusal: { name, rejected: false } }),
              (error) =>
                record({
                  refusal: { name, rejected: true, error: String(error) },
                }),
            );
        try {
          const before = await bounded(
            window.webContents.executeJavaScript(
              "document.querySelector('output').textContent",
            ),
            abort.signal,
          );
          const obs = await bounded(
            cdp.inspect("owned-watch", tab.tabId, abort.signal),
            abort.signal,
          );
          const button = obs.targets.find(
            (t) => t.name === "Owned browser action",
          );
          if (!button) throw Error("Owned button missing");
          await bounded(
            cdp.click(
              "owned-watch",
              tab.tabId,
              obs.observationId,
              button.targetId,
              abort.signal,
            ),
            abort.signal,
          );
          const after = await bounded(
            window.webContents.executeJavaScript(
              "document.querySelector('output').textContent",
            ),
            abort.signal,
          );
          record({
            browserReadback: {
              before,
              after,
              incremented: Number(after) === Number(before) + 1,
            },
          });
        } catch (error) {
          record({ browserError: String(error) });
        }
      }
      await flush();
      await pause(1500, abort.signal);
    }
  } catch (error) {
    failed = !abort.signal.aborted;
    record({
      harnessError: String(error),
      deadlineReached: abort.signal.aborted,
    });
  } finally {
    cleanup.pendingAtAbort = pending.size;
    clearTimeout(timer);
    abort.abort(new Error("State watch cleanup"));
    const clean = async (name: string, operation: () => unknown) => {
      try {
        await bound(
          Promise.resolve().then(operation),
          AbortSignal.timeout(2000),
        );
        cleanup[name] = true;
      } catch (error) {
        cleanup.errors.push({ name, error: String(error) });
      }
    };
    // Independent cleanup steps: a failing close must not skip another owned resource.
    await clean("environmentClosed", () => environment?.close());
    await clean("computerClosed", () => computer?.close());
    await clean("browserClosed", () => cdp?.close());
    await clean("windowClosed", () => window?.destroy());
    await clean("childExited", async () => {
      if (!fixture || fixture.exitCode !== null || fixture.signalCode !== null)
        return;
      fixture.kill();
      await new Promise<void>((resolve) =>
        fixture!.once("exit", () => resolve()),
      );
    });
    await clean(
      "serverClosed",
      () =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    await clean("operationsSettled", () => Promise.allSettled([...pending]));
    cleanup.pendingOperations = pending.size;
    cleanup.profileCleanupOwner = "launcher";
    await clean("recordsWritten", flush);
    await clean("cleanupWritten", () =>
      writeFile(
        path.join(output!, "cleanup.json"),
        JSON.stringify(cleanup, null, 2),
      ),
    );
    console.log(JSON.stringify({ output, cleanup }));
    app.exit(failed || cleanup.errors.length ? 1 : 0);
  }
}

// Deterministic real-macOS provider evaluation. No model/API calls or global input.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { runMacosStateWatch } from "./macos-state-watch.js";
import { writeFile, copyFile, rm } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { bounded, pause, evaluationDuration } from "./macos-eval-lifecycle.mjs";
import path from "node:path";
import os from "node:os";
import { app, BrowserWindow, screen } from "electron";
import {
  createEvaluationServer,
  evaluationPage,
} from "../evals/browser-computer/fixture.mjs";
import { createElectronWorkspaceBrowser } from "../src/main/workspace-browser-electron.js";
import { BrowserZenXCapabilityPackage } from "../src/main/capabilities/browser-provider.js";
import {
  ComputerZenXCapabilityPackage,
  ElectronMacComputerBackend,
} from "../src/main/capabilities/computer-provider.js";

let sourceRevision = "unavailable",
  holdMs = 0,
  durationMs = 300000;
const evidence = process.env.ZENX_MACOS_EVAL_DIR;
try {
  if (!evidence)
    throw Error("Set ZENX_MACOS_EVAL_DIR to a fresh private output directory");
  sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 2000,
  }).trim();
  holdMs = evaluationDuration(
    "ZENX_MACOS_FIXTURE_HOLD_MS",
    process.env.ZENX_MACOS_FIXTURE_HOLD_MS,
    0,
    true,
  );
  durationMs = evaluationDuration(
    "ZENX_MACOS_EVAL_TIMEOUT_MS",
    process.env.ZENX_MACOS_EVAL_TIMEOUT_MS,
    300000,
  );
} catch (error) {
  console.error(String(error));
  app.exit(2);
}
if (process.argv.includes("--state-watch")) {
  void runMacosStateWatch();
} else void main();
async function main() {
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error("Evaluation deadline reached")),
    Math.min(durationMs, 280000),
  );
  let scratch: string | undefined;
  let server: ReturnType<typeof createEvaluationServer> | undefined;
  let capability: BrowserZenXCapabilityPackage | undefined;
  let fixture: BrowserWindow | undefined;
  const records: any[] = [];
  const cases: any[] = [];
  const cleanup: any = { errors: [] };
  const pending = new Set<Promise<unknown>>();
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const front = async () =>
    (
      await promisify(execFile)(
        "/usr/bin/swift",
        [
          "-e",
          'import AppKit; print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown")',
        ],
        { signal: controller.signal, timeout: 20000 },
      )
    ).stdout.trim();
  try {
    mkdirSync(evidence!, { recursive: false, mode: 0o700 });
    scratch = mkdtempSync(path.join(os.tmpdir(), "zenx-macos-eval-"));
    cleanup.scratch = scratch;
    app.setPath("userData", path.join(scratch, "profile"));
    app.setActivationPolicy("accessory");
    app.on("window-all-closed", () => undefined);
    if (process.env.ZENX_MACOS_EVAL_FAIL_AT === "after-profile")
      throw Error("Injected failure after profile");
    server = createEvaluationServer();
    await bounded(app.whenReady(), controller.signal);
    const browser = createElectronWorkspaceBrowser({
      artifactDirectory: path.join(evidence!, "browser"),
    });
    browser.bindThreadSession("macos-eval", "macos-eval-thread");
    capability = new BrowserZenXCapabilityPackage(browser);
    const computer = new ComputerZenXCapabilityPackage(
      new ElectronMacComputerBackend(path.join(evidence!, "computer")),
    );
    async function invoke(
      name: string,
      args: any,
      signal = AbortSignal.timeout(60000),
    ) {
      const start = performance.now();
      try {
        const operation = (
          name.startsWith("computer_") ? computer : capability!
        ).invoke(name, {
          name,
          callId: `mac-eval-${records.length}`,
          cwd: scratch,
          arguments: { sessionId: "macos-eval", ...args },
          signal: AbortSignal.any([signal, controller.signal]),
        });
        pending.add(operation);
        operation.then(
          () => pending.delete(operation),
          () => pending.delete(operation),
        );
        const result: any = await bounded(operation, controller.signal);
        records.push({
          name,
          arguments: args,
          milliseconds: performance.now() - start,
          bytes: Buffer.byteLength(JSON.stringify(result)),
          result,
        });
        return result;
      } catch (error) {
        records.push({
          name,
          arguments: args,
          milliseconds: performance.now() - start,
          error: describe(error),
        });
        throw error;
      }
    }
    async function test(name: string, run: () => Promise<void>) {
      const start = performance.now();
      try {
        await run();
        cases.push({
          name,
          status: "pass",
          milliseconds: performance.now() - start,
        });
      } catch (error) {
        cases.push({
          name,
          status:
            /accessibility.*permission|permission.*accessibility|not trusted|not authorized/i.test(
              describe(error),
            )
              ? "blocked"
              : "fail",
          error: describe(error),
          milliseconds: performance.now() - start,
        });
      }
    }
    async function open(page: string) {
      return invoke("browser_open", { url: `${base}/${page}` });
    }
    async function inspect(tab: any) {
      return invoke("browser_inspect", { tabId: tab.tabId, full: true });
    }
    async function action(name: string, tab: any, label: string, extras = {}) {
      const obs = await inspect(tab);
      const target = obs.targets.find((t: any) => t.name === label);
      assert.ok(target, label);
      return invoke(name, {
        tabId: tab.tabId,
        observationId: obs.observationId,
        targetId: target.targetId,
        ...extras,
      });
    }
    await bounded(
      new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", resolve);
      }),
      controller.signal,
    );
    cleanup.port = (server.address() as any).port;
    if (process.env.ZENX_MACOS_EVAL_FAIL_AT === "after-listen")
      throw Error("Injected failure after listen");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const frontBefore = await front();
    const cursorBefore = screen.getCursorScreenPoint();
    await test("B1 Unicode form via tool invoke", async () => {
      const tab = await open("form");
      await action("browser_type", tab, "Recipient", { text: "ZenX 测试" });
      await action("browser_type", tab, "City", { text: "杭州" });
      await action("browser_click", tab, "Save delivery");
      const final = await inspect(tab);
      assert.match(final.visibleText, /PASS: delivery saved/);
      await copyFile(
        final.screenshot.artifactPath,
        path.join(evidence!, "B1.png"),
      );
    });
    await test("B2 scrolling and stale authority", async () => {
      const tab = await open("scroll");
      let obs = await inspect(tab);
      assert.equal(
        obs.targets.some((t: any) => t.name === "Finish task"),
        false,
      );
      for (let i = 0; i < 3; i++) {
        const args = {
          tabId: tab.tabId,
          observationId: obs.observationId,
          direction: "down",
          pixels: 800,
        };
        await invoke("browser_scroll", args);
        await assert.rejects(invoke("browser_scroll", args), /stale|unknown/);
        obs = await inspect(tab);
      }
      await action("browser_click", tab, "Finish task");
      assert.match((await inspect(tab)).visibleText, /PASS: bottom reached/);
    });
    await test("B3 replaced DOM control rejects old reference", async () => {
      const tab = await open("stale");
      const old = await inspect(tab);
      const confirm = old.targets.find((t: any) => t.name === "Confirm old");
      assert.ok(confirm);
      await action("browser_click", tab, "Refresh controls");
      await assert.rejects(
        invoke("browser_click", {
          tabId: tab.tabId,
          observationId: old.observationId,
          targetId: confirm.targetId,
        }),
        /stale|unknown/,
      );
      await action("browser_click", tab, "Confirm current");
      assert.match(
        (await inspect(tab)).visibleText,
        /PASS: current control confirmed/,
      );
    });
    await test("B4 tab inventory and cross-session isolation", async () => {
      const source = await open("tabs");
      const destination = await open("destination");
      const inventory = await invoke("browser_list_tabs", {});
      assert.ok(JSON.stringify(inventory).includes(source.tabId));
      assert.ok(JSON.stringify(inventory).includes(destination.tabId));
      browser.bindThreadSession("other-eval", "other-eval-thread");
      await assert.rejects(
        invoke("browser_inspect", {
          sessionId: "other-eval",
          tabId: source.tabId,
        }),
        /owner|session|unknown|not found/i,
      );
      await action("browser_click", source, "Confirm source retained");
      assert.match(
        (await inspect(source)).visibleText,
        /PASS: source retained/,
      );
    });
    await test("B5 disabled action and enabled selection", async () => {
      const tab = await open("disabled");
      const obs = await inspect(tab);
      const disabled = obs.targets.find(
        (t: any) => t.name === "Submit disabled",
      );
      if (disabled) assert.equal(disabled.actions.includes("click"), false);
      await action("browser_click", tab, "Submit enabled");
      assert.match(
        (await inspect(tab)).visibleText,
        /PASS: enabled action selected/,
      );
    });
    await test("B6 select checkbox contenteditable", async () => {
      const tab = await open("preferences");
      await action("browser_select", tab, "Delivery speed", {
        option: "Express",
      });
      await action("browser_click", tab, "Email updates");
      await action("browser_type", tab, "Delivery note", { text: "门口轻放" });
      await action("browser_click", tab, "Save preferences");
      assert.match(
        (await inspect(tab)).visibleText,
        /"speed":"express","updates":true,"note":"门口轻放"/,
      );
    });
    await test("aborted input cannot mutate owned page", async () => {
      const tab = await open("form");
      const obs = await inspect(tab);
      const target = obs.targets.find((t: any) => t.name === "Recipient");
      assert.ok(target);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        invoke(
          "browser_type",
          {
            tabId: tab.tabId,
            observationId: obs.observationId,
            targetId: target.targetId,
            text: "MUST NOT APPEAR",
          },
          controller.signal,
        ),
      );
      assert.equal(
        (await inspect(tab)).targets.find((t: any) => t.name === "Recipient")
          ?.value,
        "",
      );
    });
    await test("unknown tab rejects without another target", async () => {
      await assert.rejects(inspect({ tabId: "missing-owned-tab" }));
    });
    fixture = new BrowserWindow({
      width: 800,
      height: 600,
      title: "ZenX owned macOS AX fixture",
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await fixture.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(evaluationPage("form")!),
    );
    fixture.setTitle("ZenX owned macOS AX fixture");
    fixture.showInactive();
    const ownedTarget = { pid: process.pid, windowTitle: fixture.getTitle() };
    await writeFile(
      path.join(evidence, "fixture.json"),
      JSON.stringify({
        target: ownedTarget,
        nativeHandle: fixture.getNativeWindowHandle().toString("hex"),
        url: base,
        pid: process.pid,
      }),
    );
    await test("C1 scoped native AX observation", async () => {
      const obs = await invoke("computer_inspect", { target: ownedTarget });
      assert.equal(obs.target.pid, process.pid);
      assert.ok(obs.controls.length > 0);
    });
    await test("C2 native AX Unicode set_value and press", async () => {
      for (const [label, value] of [
        ["Recipient", "ZenX 测试"],
        ["City", "杭州"],
      ]) {
        const obs = await invoke("computer_inspect", { target: ownedTarget });
        const control = obs.controls.find(
          (c: any) => c.title === label && c.actions.includes("set_value"),
        );
        assert.ok(control, label);
        await invoke("computer_set_value", {
          target: ownedTarget,
          control: control.selector,
          value,
        });
        // Evaluator readback only: no DOM mutation or task action occurs here.
        const values = await fixture!.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('input')).map(e=>e.value)`,
        );
        assert.ok(values.includes(value));
      }
      const obs = await invoke("computer_inspect", { target: ownedTarget });
      const control = obs.controls.find(
        (c: any) => c.title === "Save delivery" && c.actions.includes("press"),
      );
      assert.ok(control);
      await invoke("computer_press", {
        target: ownedTarget,
        control: control.selector,
      });
      let final;
      for (let attempt = 0; attempt < 6; attempt++) {
        final = await invoke("computer_inspect", { target: ownedTarget });
        if (
          final.controls.some((c: any) =>
            c.title.includes("PASS: delivery saved"),
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const state = await fixture!.webContents.executeJavaScript(
        `({values:Array.from(document.querySelectorAll('input')).map(e=>e.value),output:document.querySelector('output').textContent})`,
      );
      await writeFile(
        path.join(evidence!, "C2-readback.json"),
        JSON.stringify(state),
      );
      await writeFile(
        path.join(evidence!, "C2.png"),
        (await fixture!.webContents.capturePage()).toPNG(),
      );
      assert.ok(
        final.controls.some((c: any) =>
          c.title.includes("PASS: delivery saved"),
        ),
        JSON.stringify(state),
      );
      await writeFile(
        path.join(evidence!, "C2.png"),
        (await fixture!.webContents.capturePage()).toPNG(),
      );
    });
    await test("Computer missing-window recovery", async () => {
      await assert.rejects(
        invoke("computer_inspect", {
          target: {
            pid: process.pid,
            windowTitle: "ZenX fixture impossible absent window",
          },
        }),
        /not found|no matching|does not|unavailable|permission|Accessibility/i,
      );
    });
    if (holdMs > 0) {
      console.log(
        JSON.stringify({
          fixtureReady: true,
          target: ownedTarget,
          pid: process.pid,
          base,
          evidence,
        }),
      );
      await pause(holdMs, controller.signal);
    }
    const frontAfter = await front();
    const cursorAfter = screen.getCursorScreenPoint();
    cases.push({
      name: "focus and system pointer isolation",
      status:
        frontBefore === frontAfter &&
        JSON.stringify(cursorBefore) === JSON.stringify(cursorAfter)
          ? "pass"
          : "fail",
      frontBefore,
      frontAfter,
      cursorBefore,
      cursorAfter,
    });
  } catch (error) {
    cases.push({
      name: "harness/startup",
      status: "blocked",
      error: describe(error),
    });
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort(new Error("Evaluation cleanup"));
    const clean = async (name: string, operation: () => unknown) => {
      try {
        await bounded(
          Promise.resolve().then(operation),
          AbortSignal.timeout(2000),
        );
        cleanup[name] = true;
      } catch (error) {
        cleanup.errors.push({ name, error: describe(error) });
      }
    };
    await clean("windowClosed", () => fixture?.destroy());
    await clean("browserClosed", () => capability?.close());
    await clean(
      "serverClosed",
      () =>
        new Promise<void>((resolve) => {
          if (!server?.listening) return resolve();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    await clean("operationsSettled", () => Promise.allSettled([...pending]));
    cleanup.pendingOperations = pending.size;
    if (scratch)
      await clean("profileRemoved", () =>
        rm(scratch!, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        }),
      );
    await clean("resultsWritten", () =>
      writeFile(
        path.join(evidence!, "results.json"),
        JSON.stringify(
          {
            source: sourceRevision,
            os: os.release(),
            platform: process.platform,
            arch: process.arch,
            cases,
            records,
            cleanup,
          },
          null,
          2,
        ),
      ),
    );
    await clean("cleanupWritten", () =>
      writeFile(
        path.join(evidence!, "cleanup.json"),
        JSON.stringify(cleanup, null, 2),
      ),
    );
    console.log(JSON.stringify({ evidence, cases, cleanup }));
    app.exit(
      cases.some((c) => c.status !== "pass") || cleanup.errors.length ? 1 : 0,
    );
  }
}

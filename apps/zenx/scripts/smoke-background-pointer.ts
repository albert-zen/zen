import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { app, screen, type WebContentsView } from "electron";

import type { BrowserInspection } from "../src/main/capabilities/browser-provider.js";
import { createElectronWorkspaceBrowser } from "../src/main/workspace-browser-electron.js";

const scratch = await mkdtemp(
  path.join(os.tmpdir(), "zenx-background-pointer-"),
);
const evidence =
  process.env.ZENX_POINTER_SMOKE_ARTIFACT_DIR ??
  path.join(os.tmpdir(), "zenx-background-pointer-evidence");
app.setPath("userData", path.join(scratch, "user-data"));
app.on("window-all-closed", () => undefined);
if (process.platform === "darwin") app.setActivationPolicy("accessory");

const fixture = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><title>ZenX pointer QA</title>
    <style>body{font:20px system-ui;background:#f3f6fb;padding:36px}main{max-width:700px;margin:auto;background:white;padding:30px;border-radius:14px}
      label,button,output{display:block;margin:24px 0}button,input,select{font:inherit;padding:12px}section{height:900px}</style>
    <main><h1>Background Agent pointer QA</h1>
      <button id="action" onclick="document.querySelector('#result').textContent='Clicked'">Agent action</button>
      <label>Agent field <input id="field" aria-label="Agent field"></label>
      <label>Agent choice <select id="choice" aria-label="Agent choice"><option value="one">One</option><option value="two">Two</option></select></label>
      <output id="result">Waiting</output><section></section><button id="bottom">Bottom</button></main>`);
});

function frontmostApp(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync(
      "/usr/bin/swift",
      [
        "-e",
        'import AppKit; print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown")',
      ],
      { encoding: "utf8", timeout: 20_000 },
    ).trim();
  } catch {
    return undefined;
  }
}

function target(
  inspection: BrowserInspection,
  name: string,
  action: string,
): string {
  const match = inspection.targets.find(
    (candidate) =>
      candidate.name === name &&
      candidate.actions.includes(action as "click" | "type" | "select"),
  );
  assert.ok(match, `Missing ${name} target for ${action}`);
  return match.targetId;
}

async function inspect(
  browser: ReturnType<typeof createElectronWorkspaceBrowser>,
  tabId: string,
): Promise<BrowserInspection> {
  return await browser.inspect("pointer-smoke-session", tabId);
}

async function pointerState(view: WebContentsView): Promise<{
  points: number[][];
  hostCount: number;
  shadowClosed: boolean;
  value: string;
  result: string;
  selected: string;
}> {
  return await view.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('[data-zenx-agent-pointer]');
    return { points: JSON.parse(host?.getAttribute('data-points') || '[]'),
      hostCount: document.querySelectorAll('[data-zenx-agent-pointer]').length,
      shadowClosed: host ? host.shadowRoot === null : false,
      value: document.querySelector('#field').value,
      result: document.querySelector('#result').textContent,
      selected: document.querySelector('#choice').value };
  })()`);
}

void app.whenReady().then(async () => {
  let view: WebContentsView | undefined;
  const browser = createElectronWorkspaceBrowser({
    artifactDirectory: path.join(scratch, "browser-artifacts"),
    onCreateView: (created) => {
      view = created;
    },
  });
  const checks: Record<string, unknown> = {
    platform: process.platform,
    evidenceDirectory: evidence,
  };
  try {
    checks.stage = "prepare";
    await mkdir(evidence, { recursive: true });
    const port = await new Promise<number>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", () => {
        const address = fixture.address();
        assert.ok(address && typeof address !== "string");
        resolve(address.port);
      });
    });
    browser.bindThreadSession("pointer-smoke-session", "pointer-smoke-thread");
    checks.stage = "baseline";
    const frontBefore = frontmostApp();
    const cursorBefore = screen.getCursorScreenPoint();
    checks.stage = "open";
    const baseUrl = `http://127.0.0.1:${port}`;
    const tab = await browser.open("pointer-smoke-session", `${baseUrl}/`);
    assert.ok(view);
    checks.stage = "inspect";
    let current = await inspect(browser, tab.tabId);
    const original = current.observationId;
    checks.stage = "click";
    await browser.click(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      target(current, "Agent action", "click"),
    );
    let state = await pointerState(view);
    assert.equal(state.result, "Clicked");
    assert.equal(state.hostCount, 1);
    assert.equal(state.points.length, 1);
    assert.equal(state.shadowClosed, true);
    current = await inspect(browser, tab.tabId);
    await copyFile(
      current.screenshot.artifactPath,
      path.join(evidence, "background-pointer-click.png"),
    );
    checks.click = {
      result: state.result,
      points: state.points,
      screenshot: "background-pointer-click.png",
    };

    await assert.rejects(
      browser.click(
        "pointer-smoke-session",
        tab.tabId,
        original,
        "stale-target",
      ),
      /stale or unknown/u,
    );
    assert.equal(
      (await pointerState(view)).hostCount,
      1,
      "Rejected action must leave prior visual intact",
    );
    checks.staleRejected = true;

    checks.stage = "type";
    await browser.type(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      target(current, "Agent field", "type"),
      "Background typing",
      false,
    );
    state = await pointerState(view);
    assert.equal(state.value, "Background typing");
    assert.equal(state.points.length, 2);
    current = await inspect(browser, tab.tabId);
    checks.stage = "select";
    await browser.select(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      target(current, "Agent choice", "select"),
      "Two",
    );
    state = await pointerState(view);
    assert.equal(state.selected, "two");
    assert.equal(state.points.length, 3);
    current = await inspect(browser, tab.tabId);
    await copyFile(
      current.screenshot.artifactPath,
      path.join(evidence, "background-pointer-trail.png"),
    );
    checks.typeAndSelect = {
      value: state.value,
      selected: state.selected,
      points: state.points,
      screenshot: "background-pointer-trail.png",
    };

    checks.stage = "scroll";
    await browser.scroll(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      "down",
      300,
    );
    assert.equal(
      (await pointerState(view)).hostCount,
      0,
      "Scroll must clear stale coordinates",
    );
    current = await inspect(browser, tab.tabId);
    await browser.scroll(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      "up",
      300,
    );
    current = await inspect(browser, tab.tabId);
    await browser.click(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      target(current, "Agent action", "click"),
    );
    assert.equal((await pointerState(view)).hostCount, 1);
    checks.stage = "resize";
    await view.webContents.executeJavaScript(
      "window.dispatchEvent(new Event('resize'))",
    );
    assert.equal(
      (await pointerState(view)).hostCount,
      0,
      "Resize must clear stale coordinates",
    );
    checks.scrollAndResizeClear = true;

    current = await inspect(browser, tab.tabId);
    await browser.click(
      "pointer-smoke-session",
      tab.tabId,
      current.observationId,
      target(current, "Agent action", "click"),
    );
    assert.equal((await pointerState(view)).hostCount, 1);
    await browser.navigate(
      "pointer-smoke-session",
      tab.tabId,
      `${baseUrl}/new-document`,
    );
    assert.equal(
      (await pointerState(view)).hostCount,
      0,
      "Navigation must clear old document visual",
    );
    checks.navigationClear = true;

    const frontAfter = frontmostApp();
    const cursorAfter = screen.getCursorScreenPoint();
    if (frontBefore !== undefined && frontAfter !== undefined) {
      assert.equal(
        frontAfter,
        frontBefore,
        "Agent actions must not activate Electron",
      );
      checks.frontmostApp = { before: frontBefore, after: frontAfter };
    } else checks.frontmostApp = "unavailable";
    assert.deepEqual(
      cursorAfter,
      cursorBefore,
      "Agent actions must not move the system pointer",
    );
    checks.systemCursor = { before: cursorBefore, after: cursorAfter };
    checks.stage = "complete";
    checks.passed = true;
    await writeFile(
      path.join(evidence, "background-pointer-smoke.json"),
      `${JSON.stringify(checks, null, 2)}\n`,
    );
    console.log(JSON.stringify(checks));
  } catch (error) {
    checks.passed = false;
    checks.error =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, "background-pointer-smoke.json"),
      `${JSON.stringify(checks, null, 2)}\n`,
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.shutdown();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    app.exit(checks.passed === true ? 0 : 1);
  }
});

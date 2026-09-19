import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  BrowserZenXCapabilityPackage,
  type BrowserInspection,
  type BrowserTabSummary,
} from "../src/main/capabilities/browser-provider.js";
import { PlaywrightCliBrowserBackend } from "../src/main/capabilities/playwright-browser-provider.js";
import { SystemExternalProviderProcessRunner } from "../src/main/capabilities/external-provider.js";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";

// Deterministic provider smoke against evals/browser-computer/fixture.mjs.
// This verifies tool behavior; it is not a model task-success score.
const [mode, runtimeOrEndpoint, fixtureUrl] = process.argv.slice(2);
if (
  (mode !== "playwright" && mode !== "cdp") ||
  !runtimeOrEndpoint ||
  !fixtureUrl
) {
  throw new Error(
    "Usage: tsx scripts/browser-interaction-smoke.ts playwright <providers-directory> <fixture-base-url> | cdp <cdp-endpoint> <fixture-base-url>",
  );
}
const backend =
  mode === "cdp"
    ? (await connectUserBrowserCdp(runtimeOrEndpoint)).backend
    : new PlaywrightCliBrowserBackend({
        executable: path.join(
          runtimeOrEndpoint,
          "playwright-cli",
          "playwright-cli.js",
        ),
        runtimeExecutable: path.join(
          runtimeOrEndpoint,
          "runtime",
          process.platform === "win32" ? "node.exe" : "node",
        ),
        runner: new SystemExternalProviderProcessRunner(),
        browser: "chromium",
        cwd: process.cwd(),
        processEnvironment: {
          PLAYWRIGHT_BROWSERS_PATH: path.join(
            runtimeOrEndpoint,
            "playwright-browsers",
          ),
        },
      });
const capability = new BrowserZenXCapabilityPackage(backend);
let calls = 0;
async function invoke(name: string, args: Record<string, unknown>) {
  calls += 1;
  return await capability.invoke(name, {
    callId: `smoke-${calls}`,
    name,
    arguments: { sessionId: "interaction-smoke", ...args },
    cwd: process.cwd(),
    signal: AbortSignal.timeout(120_000),
  });
}
async function inspect(tabId: string) {
  // New CDP tabs can still be committing their first document. Retry reads only.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await invoke("browser_inspect", { tabId })) as BrowserInspection;
    } catch (error) {
      if (
        attempt >= 4 ||
        !(error instanceof Error) ||
        !/document changed|inspect again/i.test(error.message)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
try {
  const form = (await invoke("browser_open", {
    url: new URL("/form", fixtureUrl).href,
  })) as BrowserTabSummary;
  for (const [name, text] of [
    ["Recipient", "ZenX 测试"],
    ["City", "杭州"],
  ]) {
    const observation = await inspect(form.tabId);
    const target = observation.targets.find((target) => target.name === name);
    assert.ok(target, `Expected labeled field ${name}`);
    await invoke("browser_type", {
      tabId: form.tabId,
      observationId: observation.observationId,
      targetId: target.targetId,
      text,
    });
  }
  const ready = await inspect(form.tabId);
  const save = ready.targets.find((target) => target.name === "Save delivery");
  assert.ok(save);
  await invoke("browser_click", {
    tabId: form.tabId,
    observationId: ready.observationId,
    targetId: save.targetId,
  });
  assert.match((await inspect(form.tabId)).visibleText, /PASS: delivery saved/);
  console.log(JSON.stringify({ mode, task: "B1", passed: true, calls }));
  const long = (await invoke("browser_open", {
    url: new URL("/scroll", fixtureUrl).href,
  })) as BrowserTabSummary;
  let observation = await inspect(long.tabId);
  const initialTargetExposed = observation.targets.some(
    (target) => target.name === "Finish task",
  );
  if (mode === "cdp") assert.equal(initialTargetExposed, false);
  const initialScreenshot = await readFile(observation.screenshot.artifactPath);
  for (let index = 0; index < 3; index += 1) {
    await invoke("browser_scroll", {
      tabId: long.tabId,
      observationId: observation.observationId,
      direction: "down",
      pixels: 800,
    });
    await assert.rejects(
      invoke("browser_scroll", {
        tabId: long.tabId,
        observationId: observation.observationId,
        direction: "down",
        pixels: 800,
      }),
      /stale or unknown/,
    );
    observation = await inspect(long.tabId);
    if (index === 0) {
      assert.notDeepEqual(
        await readFile(observation.screenshot.artifactPath),
        initialScreenshot,
        "Page scroll must change the static fixture viewport before click auto-scroll can run",
      );
    }
  }
  const finish = observation.targets.find(
    (target) => target.name === "Finish task",
  );
  assert.ok(finish, "Scrolling must reveal the below-fold button");
  await invoke("browser_click", {
    tabId: long.tabId,
    observationId: observation.observationId,
    targetId: finish.targetId,
  });
  assert.match((await inspect(long.tabId)).visibleText, /PASS: bottom reached/);
  console.log(
    JSON.stringify({
      mode,
      task: "B2",
      passed: true,
      calls,
      initialTargetExposed,
    }),
  );
} finally {
  await capability.close();
}

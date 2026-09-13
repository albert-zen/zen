import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { startupScreenHtml as renderStartup } from "../src/main/startup-screen.js";

const appearanceBootstrap = readFileSync(
  new URL("../src/renderer/index.html", import.meta.url),
  "utf8",
).match(/<script>([\s\S]*?)<\/script>/u)![1]!;
const startupScreenHtml = (error?: string) =>
  renderStartup(appearanceBootstrap, error);

test("startup screen is visible content with only the hashed appearance bootstrap and no IPC dependency", () => {
  const document = new JSDOM(startupScreenHtml()).window.document;
  assert.match(
    document.querySelector('[role="status"]')?.textContent ?? "",
    /Preparing your superpower/u,
  );
  assert.equal(document.querySelectorAll("script").length, 1);
  const script = document.querySelector("script")!.textContent!;
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!
      .includes(`'sha256-${hash}'`),
  );
  assert.doesNotMatch(script, /window\.zenx|ipcRenderer/);
  assert.ok(
    document.querySelector('svg[data-geometry="zenx-board04-mechanical-v1"]'),
  );
  assert.match(
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content") ?? "",
    /default-src 'none'/u,
  );
});
test("startup failure renders the actual error as inert text", () => {
  const error = "<script>bad()</script> & unavailable";
  const document = new JSDOM(startupScreenHtml(error)).window.document;
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /<script>bad\(\)<\/script> & unavailable/u,
  );
  assert.equal(document.querySelectorAll("script").length, 1);
  const script = document.querySelector("script")!.textContent!;
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!
      .includes(`'sha256-${hash}'`),
  );
  assert.doesNotMatch(script, /window\.zenx|ipcRenderer/);
});

test("startup respects the app mode before first paint, using system only when selected", () => {
  for (const [stored, systemDark, expected] of [
    [JSON.stringify({ mode: "light" }), true, "light"],
    [JSON.stringify({ mode: "dark" }), false, "dark"],
    [JSON.stringify({ mode: "system" }), true, "dark"],
    ["light", true, "light"],
    ["broken", false, "light"],
  ] as const) {
    const dom = new JSDOM(startupScreenHtml(), {
      url: "https://zenx.test/startup.html",
      runScripts: "dangerously",
      beforeParse(window) {
        window.localStorage.setItem("zenx.appearance", stored);
        Object.defineProperty(window, "matchMedia", {
          value: () => ({ matches: systemDark }),
        });
      },
    });
    assert.equal(
      dom.window.document.documentElement.dataset.appearance,
      expected,
    );
    dom.window.close();
  }
});

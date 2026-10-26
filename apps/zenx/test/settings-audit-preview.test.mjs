import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
const execute = promisify(execFile);
const waitFor = async (predicate) => {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Audit fixture did not reach expected DOM state");
};
test("Settings audit HTML boots actual editor, preserves unknown catalog data and exercises validation without Host", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zenx-settings-audit-test-"),
  );
  let dom;
  try {
    await execute(
      process.execPath,
      [
        new URL("../scripts/build-settings-audit-preview.mjs", import.meta.url)
          .pathname,
        directory,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const html = await readFile(
      path.join(directory, "settings-audit.html"),
      "utf8",
    );
    assert.match(html, /connect-src 'none'/u);
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => {
      if (
        error.type !== "css-parsing" &&
        !error.message.includes("Could not parse CSS stylesheet")
      )
        errors.push(String(error));
    });
    dom = new JSDOM(html, {
      url: "http://localhost/settings-audit.html?lang=en",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.structuredClone = structuredClone;
        window.matchMedia = () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        });
        window.HTMLElement.prototype.scrollIntoView = () => undefined;
        Object.defineProperty(window.document, "fonts", {
          value: { ready: Promise.resolve() },
        });
      },
    });
    const document = dom.window.document;
    await waitFor(
      () => document.querySelectorAll(".provider-profile-card").length === 4,
    );
    document.querySelectorAll(".provider-profile-actions button")[6].click();
    await waitFor(
      () => document.querySelectorAll(".provider-model-row").length === 12,
    );
    document.querySelector(".model-catalog-head button").click();
    await waitFor(
      () => document.querySelectorAll(".available-model-option").length === 2,
    );
    document.querySelectorAll(".available-model-option input")[1].click();
    await waitFor(
      () =>
        !document.querySelector(".available-model-actions .primary-button")
          .disabled,
    );
    document.querySelector(".available-model-actions .primary-button").click();
    await waitFor(
      () => document.querySelectorAll(".provider-model-row").length === 13,
    );
    assert.match(
      document.querySelectorAll(".provider-model-capabilities summary")[12]
        .textContent,
      /unknown/iu,
    );
    document.querySelector(".provider-editor-actions [type=submit]").click();
    await waitFor(() =>
      document.querySelector(".provider-editor-error-summary"),
    );
    assert.match(
      document.querySelector(".provider-editor-error-summary").textContent,
      /positive whole number for context/iu,
    );
    document.querySelector(".provider-editor-error-summary a").click();
    assert.equal(document.activeElement.id.includes("contextWindow"), true);
    assert.equal(document.activeElement.closest("details").open, true);
    document.querySelector(".provider-editor-head button").click();
    await waitFor(() => !document.querySelector(".provider-editor"));
    document.querySelector(".provider-section-actions .primary-button").click();
    await waitFor(() => document.querySelector(".provider-editor"));
    assert.ok(
      document.querySelector(".model-catalog-head button") === null,
      "Current add flow has no discovery action; observation, not desired behavior.",
    );
    document.querySelector(".provider-editor-actions [type=submit]").click();
    await waitFor(() =>
      document.querySelector(".provider-editor-error-summary"),
    );
    assert.match(
      document.querySelector(".provider-editor-error-summary").textContent,
      /positive whole number for context/iu,
    );
    assert.deepEqual(
      [...dom.window.__settingsAudit.calls].filter(
        (x) => x !== "validation-diagnostic",
      ),
      ["settings-get", "synthetic-discovery"],
    );
    assert.deepEqual(errors, []);
    const capture = await readFile(
      new URL("../scripts/capture-settings-audit-preview.mjs", import.meta.url),
      "utf8",
    );
    assert.equal(capture.includes('"--no-sandbox"'), false);
    assert.match(capture, /process.env.GITHUB_ACTIONS/u);
  } finally {
    dom?.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Settings audit uses actual language controller and recovers synthetic initial failure", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zenx-settings-retry-test-"),
  );
  let dom;
  try {
    await execute(
      process.execPath,
      [
        new URL("../scripts/build-settings-audit-preview.mjs", import.meta.url)
          .pathname,
        directory,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const html = await readFile(
      path.join(directory, "settings-audit.html"),
      "utf8",
    );
    dom = new JSDOM(html, {
      url: "http://localhost/settings-audit.html?lang=zh-CN&initialFailure=1&deferredSave=1",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.structuredClone = structuredClone;
        window.matchMedia = () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        });
        window.HTMLElement.prototype.scrollIntoView = () => undefined;
      },
    });
    const document = dom.window.document;
    await waitFor(() => document.querySelector(".page-loading button"));
    assert.ok(
      document.querySelector(".loading-ring") === null,
      "Settled failure has no spinner",
    );
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Synthetic settings load failure/,
    );
    assert.equal(
      document.querySelector(".page-loading button")?.textContent,
      "重试加载设置",
    );
    document.querySelector(".page-loading button").click();
    await waitFor(
      () => document.querySelectorAll(".provider-profile-card").length === 4,
    );
    assert.match(
      document.querySelector(".settings-view")?.textContent ?? "",
      /模型与服务商/,
    );
    assert.equal(
      dom.window.__settingsAudit.calls.filter((x) => x === "settings-get")
        .length,
      2,
    );
    const snapshot = await dom.window.zenx.settings.get();
    for (const outcome of ["success", "failure"]) {
      const pending = dom.window.zenx.settings.editProvider(
        "synthetic-3",
        snapshot.profile.providerProfiles[3],
        {},
        "fixture-attempt",
      );
      dom.window.__settingsAudit.settleProviderEdit(outcome);
      const reply = await pending;
      assert.equal(reply.attemptId, "fixture-attempt");
      assert.equal(reply.ok, outcome === "success");
      if (reply.ok) {
        assert.equal(reply.outcome, "success");
        assert.deepEqual(reply.settings, snapshot);
      } else {
        assert.equal(reply.outcome, "failed");
        assert.equal(reply.code, "save-rejected");
      }
    }
    await assert.rejects(dom.window.zenx.settings.addProvider({}), /no Host/);
    await assert.rejects(
      dom.window.zenx.settings.deleteProvider("synthetic-3"),
      /no Host/,
    );
    assert.equal(
      dom.window.localStorage.length,
      0,
      "Fixture locale does not write a stored preference",
    );
  } finally {
    dom?.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("Metadata preview changes existing input only and preserves unknown/manual fields", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zenx-metadata-preview-"),
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
    for (const lang of ["en", "zh-CN"]) {
      dom = new JSDOM(html, {
        url: `http://localhost/settings-audit.html?lang=${lang}&metadata=1`,
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
      await waitFor(
        () => document.querySelectorAll(".provider-profile-card").length === 4,
      );
      document.querySelector(".provider-profile-actions button").click();
      await waitFor(() => document.querySelector(".model-catalog-head button"));
      const rowText = () =>
        document.querySelector(".provider-model-row").textContent;
      assert.match(rowText(), lang === "en" ? /input unknown/u : /输入未知/u);
      const manualBefore = document.querySelectorAll(".provider-model-row")[1]
        .textContent;
      document.querySelector(".model-catalog-head button").click();
      await waitFor(() =>
        document.querySelector(".model-catalog-status button"),
      );
      document.querySelector(".model-catalog-status button").click();
      await waitFor(
        () => !document.querySelector(".model-catalog-status button"),
      );
      assert.match(rowText(), /text \+ image/u);
      assert.match(
        rowText(),
        lang === "en" ? /reasoning unknown/u : /推理未知/u,
      );
      assert.match(
        rowText(),
        lang === "en" ? /context required/u : /需要上下文/u,
      );
      assert.equal(
        document.querySelectorAll(".provider-model-row")[1].textContent,
        manualBefore,
      );
      assert.equal(
        dom.window.__settingsAudit.calls.some((x) => x.includes("save")),
        false,
      );
      dom.window.close();
      dom = undefined;
    }
  } finally {
    dom?.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("General guidance and production directory portal use synthetic read-only journeys in both locales", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zenx-settings-journeys-"),
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
    for (const lang of ["en", "zh-CN"]) {
      const errors = [];
      const virtualConsole = new VirtualConsole();
      virtualConsole.on("jsdomError", (error) => {
        if (
          error.type !== "css-parsing" &&
          !error.message.includes("Could not parse CSS stylesheet")
        )
          errors.push(String(error));
      });
      const boot = (suffix) =>
        new JSDOM(html, {
          url: `http://localhost/settings-audit.html?lang=${lang}&${suffix}`,
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
            window.ResizeObserver = class {
              observe() {}
              unobserve() {}
              disconnect() {}
            };
          },
        });
      dom = boot("");
      let document = dom.window.document;
      await waitFor(() => document.querySelector("#settings-tab-general"));
      document.querySelector("#settings-tab-general").click();
      await waitFor(() =>
        document.querySelector("details.settings-send-shortcuts"),
      );
      const details = document.querySelector("details.settings-send-shortcuts");
      assert.equal(details.open, false);
      details.querySelector("summary").click();
      assert.equal(details.open, true);
      assert.ok(
        document.querySelector("#foreground-control-help").textContent.trim(),
      );
      const foreground = document.querySelector(".settings-foreground-control");
      assert.equal(
        foreground
          .querySelector("[role=switch]")
          .getAttribute("aria-describedby"),
        "foreground-control-risk foreground-control-help",
      );
      assert.ok(
        foreground.contains(document.querySelector("#foreground-control-risk")),
      );
      assert.ok(
        foreground.contains(document.querySelector("#foreground-control-help")),
      );
      dom.window.close();
      dom = boot("scene=directory&directoryFailure=1");
      document = dom.window.document;
      await waitFor(() => document.querySelector("#directory-audit-open"));
      const launch = document.querySelector("#directory-audit-open");
      launch.focus();
      launch.click();
      await waitFor(() =>
        document.querySelector(".directory-picker-error button"),
      );
      assert.ok(
        document.querySelector('[role="dialog"].directory-picker-shell'),
      );
      assert.equal(
        document
          .querySelector("#root")
          .contains(document.querySelector(".directory-picker-shell")),
        false,
      );
      assert.equal(
        document.querySelector(
          ".directory-picker-dialog footer .primary-button",
        ).disabled,
        true,
      );
      assert.equal(document.querySelector(".directory-picker-body nav"), null);
      assert.equal(
        document.querySelector(".directory-picker-breadcrumbs"),
        null,
      );
      document.querySelector(".directory-picker-error button").click();
      await waitFor(() =>
        document.querySelector('.directory-picker-list [data-index="0"]'),
      );
      assert.ok(
        document.querySelector(
          '.directory-picker-breadcrumbs [aria-current="location"]',
        ),
      );
      assert.equal(
        document
          .querySelector(".directory-picker-dialog footer .primary-button")
          .getAttribute("aria-describedby"),
        "directory-picker-selection",
      );
      assert.equal(
        document.querySelector('.directory-picker-list [data-active="true"]'),
        null,
      );
      document.querySelector('.directory-picker-list [data-index="0"]').click();
      await waitFor(
        () =>
          document.querySelector(".directory-picker-dialog footer strong")
            ?.textContent === "/synthetic/empty",
      );
      assert.equal(
        document.querySelectorAll(".directory-picker-list [data-index]").length,
        0,
      );
      document.querySelector(".directory-picker-breadcrumbs button").click();
      await waitFor(() =>
        document.querySelector('.directory-picker-list [data-index="0"]'),
      );
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      await waitFor(() => !document.querySelector(".directory-picker-shell"));
      await waitFor(() => document.activeElement === launch);
      launch.click();
      await waitFor(() =>
        document.querySelector('.directory-picker-list [data-index="0"]'),
      );
      document
        .querySelector(".directory-picker-dialog footer .secondary-button")
        .click();
      await waitFor(() => !document.querySelector(".directory-picker-shell"));
      assert.deepEqual(
        [...dom.window.__directoryAudit.calls],
        [
          "snapshot",
          "snapshot",
          "list:/synthetic",
          "list:/synthetic/empty",
          "list:/synthetic",
          "snapshot",
          "list:/synthetic",
        ],
      );
      assert.deepEqual(errors, []);
      dom.window.close();
      dom = undefined;
    }
  } finally {
    dom?.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

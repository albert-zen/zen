import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import type {
  ExternalProviderProcessResult,
  ExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";
import {
  PlaywrightCliBrowserBackend,
  playwrightSelectActionCode,
} from "../src/main/capabilities/playwright-browser-provider.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("Playwright screenshot decodes the JSON-stringified CLI result", async () => {
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner: new FakePlaywrightRunner(),
    cwd: "/tmp/zenx-playwright",
  });
  try {
    const tab = await backend.open("screenshot", "https://example.com/");
    const inspection = await backend.inspect("screenshot", tab.tabId);
    assert.deepEqual(
      await readFile(inspection.screenshot.artifactPath),
      Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
    );
  } finally {
    await backend.close();
  }
});

test("Playwright page scroll rejects stale observations and dispatches one bounded page mutation", async () => {
  const runner = new FakePlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  try {
    const tab = await backend.open("research", "https://example.com/");
    const inspected = await backend.inspect("research", tab.tabId);
    await assert.rejects(
      backend.scroll("research", tab.tabId, "forged", "down", 600),
      /stale or unknown/,
    );
    await backend.scroll(
      "research",
      tab.tabId,
      inspected.observationId,
      "down",
      600,
    );
    await assert.rejects(
      backend.scroll(
        "research",
        tab.tabId,
        inspected.observationId,
        "down",
        600,
      ),
      /stale or unknown/,
    );
    const dispatched = runner.calls.filter((args) =>
      args[3]?.includes("window.scrollBy"),
    );
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0]![3]!, /top: 600/);
    assert.match(dispatched[0]![3]!, /__zenx_document_key/);
  } finally {
    await backend.close();
  }
});

test("Playwright provider runs an isolated JSON-only observe/action slice", async () => {
  const runner = new FakePlaywrightRunner();
  const browserPath = "/opt/verified-playwright-browsers";
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
    browser: "chromium",
    processEnvironment: { PLAYWRIGHT_BROWSERS_PATH: browserPath },
  });
  const opened = await backend.open("research", "https://example.com/");
  assert.equal(opened.title, "Fixture");
  const inspected = await backend.inspect("research", opened.tabId);
  assert.match(inspected.visibleText, /Run/u);
  assert.equal(inspected.screenshot.observationId, inspected.observationId);
  assert.ok(inspected.screenshot.bytes > 0);
  const button = inspected.targets.find(({ name }) => name === "Run");
  assert.ok(button);
  await assert.rejects(
    backend.click(
      "research",
      opened.tabId,
      inspected.observationId,
      "forged-target",
    ),
    /forged/u,
  );
  await backend.click(
    "research",
    opened.tabId,
    inspected.observationId,
    button.targetId,
  );
  await assert.rejects(
    backend.click(
      "research",
      opened.tabId,
      inspected.observationId,
      button.targetId,
    ),
    /stale or unknown/u,
  );
  assert.ok(runner.calls.every((args) => args[0] === "--json"));
  assert.deepEqual(runner.calls.find((args) => args[2] === "open")?.slice(-2), [
    "--browser",
    "chromium",
  ]);
  assert.equal(
    runner.environments.find(
      (_environment, index) => runner.calls[index]?.[2] === "open",
    )?.PLAYWRIGHT_BROWSERS_PATH,
    browserPath,
  );
  assert.ok(runner.calls.some((args) => args.includes("snapshot")));
  assert.ok(runner.calls.some((args) => args.includes("click")));
});

test("Playwright tab summaries redact URL credentials and values", async () => {
  const runner = new FakePlaywrightRunner();
  runner.url = "https://alice:secret@example.com/private?q=token#fragment";
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  const opened = await backend.open("research", runner.url);
  assert.equal(opened.url, "https://example.com/private");
  const listed = await backend.listTabs("research");
  assert.equal(listed[0]?.url, "https://example.com/private");
  await backend.close();
});

test("Playwright re-hashes the browser tree only before a browser launch", async () => {
  const runner = new FakePlaywrightRunner();
  let browserVerifications = 0;
  let invocationVerifications = 0;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
    verifyBrowserBeforeLaunch: async () => {
      browserVerifications += 1;
    },
    verifyExecutable: async () => {
      invocationVerifications += 1;
    },
  });
  const opened = await backend.open("research", "https://example.com/");
  await backend.inspect("research", opened.tabId);
  assert.equal(browserVerifications, 1);
  assert.equal(invocationVerifications, runner.calls.length - 1);
  assert.equal(
    runner.calls.filter((args) => args[2] === "tab-select").length,
    0,
  );
  await backend.close();
});

test("Playwright provider fails closed on an incompatible snapshot schema", async () => {
  const runner = new FakePlaywrightRunner();
  runner.invalidSnapshot = true;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  const opened = await backend.open("research", "https://example.com/");
  await assert.rejects(
    backend.inspect("research", opened.tabId),
    /snapshot must be an array/u,
  );
});

test("Playwright provider revalidates DOM identity and dispatches password fill normally", async () => {
  const runner = new FakePlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  const opened = await backend.open("research", "https://example.com/");
  const inspected = await backend.inspect("research", opened.tabId);
  const password = inspected.targets.find(({ name }) => name === "Password");
  assert.deepEqual(password?.actions, ["click", "type"]);
  assert.ok(password);
  await backend.type(
    "research",
    opened.tabId,
    inspected.observationId,
    password.targetId,
    "ordinary argument",
    false,
  );
  assert.equal(runner.calls.filter((args) => args.includes("fill")).length, 1);
  const refreshed = await backend.inspect("research", opened.tabId);
  assert.equal(
    inspected.targets.some(({ name }) => name === "Hidden"),
    false,
  );
  const button = refreshed.targets.find(({ name }) => name === "Run");
  assert.ok(button);
  runner.changeIdentity = true;
  await assert.rejects(
    backend.click(
      "research",
      opened.tabId,
      refreshed.observationId,
      button.targetId,
    ),
    /identity, visibility, or actions changed/u,
  );
  assert.equal(runner.calls.filter((args) => args.includes("click")).length, 0);
});

test("Playwright inspection only advertises type for editable comboboxes", async () => {
  const runner = new FakePlaywrightRunner();
  runner.includeComboboxes = true;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  try {
    const opened = await backend.open("preferences", "https://example.com/");
    const inspected = await backend.inspect("preferences", opened.tabId);
    assert.deepEqual(
      inspected.targets.find(({ name }) => name === "Delivery speed")?.actions,
      ["click", "select"],
    );
    const speed = inspected.targets.find(
      ({ name }) => name === "Delivery speed",
    )!;
    assert.equal(speed.value, "standard");
    assert.equal(speed.options?.[1]?.label, "Express");
    assert.deepEqual(
      inspected.targets.find(({ name }) => name === "Search cities")?.actions,
      ["click", "type"],
    );
    await backend.select(
      "preferences",
      opened.tabId,
      inspected.observationId,
      speed.targetId,
      "Express",
    );
    assert.ok(
      runner.calls.some(
        (args) =>
          args[2] === "run-code" &&
          args[3]?.includes("HTMLSelectElement.prototype"),
      ),
    );
    assert.deepEqual(
      inspected.targets.find(({ name }) => name === "Custom city")?.actions,
      ["click", "type"],
    );
  } finally {
    await backend.close();
  }
});

test("Playwright native select validates and mutates in one page callback", async () => {
  const dom = new JSDOM(
    `<select><option value="standard">Standard</option><option value="express">Express</option></select>`,
    { runScripts: "outside-only" },
  );
  try {
    const select = dom.window.document.querySelector("select")!;
    const events: string[] = [];
    select.addEventListener("input", () => events.push("input"));
    select.addEventListener("change", () => events.push("change"));
    let evaluateCalls = 0;
    const page = {
      locator(selector: string) {
        assert.equal(selector, "aria-ref=e5");
        return {
          async evaluate(
            callback: (element: HTMLSelectElement, argument: unknown) => void,
            argument: unknown,
          ) {
            evaluateCalls += 1;
            callback(select, argument);
          },
        };
      },
    };
    const action = dom.window.eval(
      `(${playwrightSelectActionCode(
        {
          ref: "e5",
          options: [
            {
              value: "standard",
              label: "Standard",
              selected: true,
              disabled: false,
            },
            {
              value: "express",
              label: "Express",
              selected: false,
              disabled: false,
            },
          ],
        },
        "Express",
      )})`,
    ) as (page: unknown) => Promise<void>;
    await action(page);
    assert.equal(evaluateCalls, 1);
    assert.equal(select.value, "express");
    assert.deepEqual(events, ["input", "change"]);
  } finally {
    dom.window.close();
  }
});

test("Playwright rejects select metadata without options completeness", async () => {
  const runner = new FakePlaywrightRunner();
  runner.includeComboboxes = true;
  runner.omitSelectOptions = true;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  const opened = await backend.open("preferences", "https://example.com/");
  await assert.rejects(
    backend.inspect("preferences", opened.tabId),
    /invalid DOM metadata entry/u,
  );
  await backend.close();
});

test("Playwright rejects select options changed after inspection", async () => {
  const runner = new FakePlaywrightRunner();
  runner.includeComboboxes = true;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  try {
    const opened = await backend.open("preferences", "https://example.com/");
    const inspected = await backend.inspect("preferences", opened.tabId);
    const speed = inspected.targets.find(
      ({ name }) => name === "Delivery speed",
    )!;
    runner.changeSelectOptions = true;
    await assert.rejects(
      backend.select(
        "preferences",
        opened.tabId,
        inspected.observationId,
        speed.targetId,
        "Express",
      ),
      /changed|inspect again/u,
    );
    assert.equal(
      runner.calls.filter(
        (args) =>
          args[2] === "run-code" &&
          args[3]?.includes("HTMLSelectElement.prototype"),
      ).length,
      0,
    );
  } finally {
    await backend.close();
  }
});

test("Playwright cancellation invalidates the session before immediate reuse", async () => {
  const runner = new FakePlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  const first = await backend.open("research", "https://example.com/first");
  runner.abortNextSnapshot = true;
  runner.delayNextClose();
  await assert.rejects(backend.inspect("research", first.tabId), /cancelled/u);

  const second = await backend.open("research", "https://example.com/second");
  const openSessions = runner.calls
    .filter((args) => args[2] === "open")
    .map((args) => args[1]);
  assert.equal(openSessions.length, 2);
  assert.notEqual(openSessions[0], openSessions[1]);
  await assert.rejects(
    backend.inspect("research", first.tabId),
    /unknown or scoped to another session/u,
  );
  assert.notEqual(second.tabId, first.tabId);

  runner.releaseDelayedClose();
  await runner.delayedCloseFinished;
  await backend.close();
});

test("Playwright rejects unbounded or multiply-current page state before reconciliation", async () => {
  const runner = new FakePlaywrightRunner();
  runner.invalidPages = true;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  await assert.rejects(
    backend.open("research", "https://example.com/"),
    /page state|exactly one page/u,
  );
  await backend.close();
});

class FakePlaywrightRunner implements ExternalProviderProcessRunner {
  onCommand?: (command: string, args: readonly string[]) => void;
  crowded = false;
  readonly calls: string[][] = [];
  readonly environments: Array<NodeJS.ProcessEnv | undefined> = [];
  url = "https://example.com/";
  tabKey = "__zenx_tab_fixture";
  documentKey = "document-fixture";
  invalidSnapshot = false;
  invalidPages = false;
  changeIdentity = false;
  includeComboboxes = false;
  changeSelectOptions = false;
  omitSelectOptions = false;
  abortNextSnapshot = false;
  delayedCloseFinished: Promise<void> = Promise.resolve();
  #snapshotCount = 0;
  #delayClose = false;
  #releaseClose: (() => void) | undefined;
  #finishDelayedClose: (() => void) | undefined;

  delayNextClose(): void {
    this.#delayClose = true;
    this.delayedCloseFinished = new Promise((resolve) => {
      this.#finishDelayedClose = resolve;
    });
  }

  releaseDelayedClose(): void {
    this.#releaseClose?.();
  }

  async run(
    _executable: string,
    args: readonly string[],
    options: {
      timeoutMs: number;
      environment?: NodeJS.ProcessEnv;
      verifyBeforeSpawn?: () => Promise<void>;
    },
  ): Promise<ExternalProviderProcessResult> {
    await options.verifyBeforeSpawn?.();
    this.calls.push([...args]);
    this.environments.push(options.environment);
    const command = args[2];
    this.onCommand?.(command!, args);
    let response: Record<string, unknown> = {};
    if (command === "open") {
      this.url = args[3] ?? this.url;
      response = { session: args[1]?.slice(3), result: {} };
    } else if (command === "close" && this.#delayClose) {
      this.#delayClose = false;
      await new Promise<void>((resolve) => {
        this.#releaseClose = resolve;
      });
      this.#finishDelayedClose?.();
    } else if (command === "run-code" && args[3]?.includes("screenshot")) {
      response = {
        result: JSON.stringify(ONE_PIXEL_PNG_BASE64),
      };
    } else if (command === "run-code") {
      response = args[3]?.includes("aria-ref=")
        ? {
            result: JSON.stringify([
              dom("e1", { tag: "button" }),
              dom("e2", { tag: "input", type: "text" }),
              dom("e3", {
                tag: "input",
                type: "password",
                autocomplete: "current-password",
              }),
              dom("e4", { tag: "button", visible: false }),
              ...(this.includeComboboxes
                ? [
                    dom("e5", {
                      tag: "select",
                      value: "standard",
                      ...(this.omitSelectOptions
                        ? {}
                        : {
                            optionsTruncated: false,
                            options: [
                              {
                                value: "standard",
                                label: "Standard",
                                selected: true,
                                disabled: false,
                              },
                              {
                                value: "express",
                                label: "Express",
                                selected: false,
                                disabled: false,
                              },
                              ...(this.changeSelectOptions
                                ? [
                                    {
                                      value: "same-day",
                                      label: "Same day",
                                      selected: false,
                                      disabled: false,
                                    },
                                  ]
                                : []),
                            ],
                          }),
                    }),
                    dom("e6", { tag: "input", type: "search" }),
                    dom("e7", { tag: "div" }),
                  ]
                : []),
            ]),
          }
        : args[3]?.includes("window.name")
          ? {
              result: JSON.stringify([
                {
                  index: 0,
                  title: "Fixture",
                  url: this.url,
                  current: true,
                  tabKey: this.tabKey,
                  documentKey: this.documentKey,
                },
                ...(this.invalidPages
                  ? [
                      {
                        index: 1,
                        title: "Second",
                        url: this.url,
                        current: true,
                        tabKey: "__zenx_tab_second",
                        documentKey: "document-second",
                      },
                    ]
                  : []),
              ]),
            }
          : {
              result: JSON.stringify([
                {
                  index: 0,
                  title: "Fixture",
                  url: this.url,
                  current: true,
                  tabKey: this.tabKey,
                  documentKey: this.documentKey,
                },
                ...(this.invalidPages
                  ? [
                      {
                        index: 1,
                        title: "Second",
                        url: this.url,
                        current: true,
                        tabKey: "__zenx_tab_second",
                        documentKey: "document-second",
                      },
                    ]
                  : []),
              ]),
            };
    } else if (command === "snapshot") {
      if (this.abortNextSnapshot) {
        this.abortNextSnapshot = false;
        throw new DOMException("provider cancelled", "AbortError");
      }
      this.#snapshotCount += 1;
      response = this.invalidSnapshot
        ? { snapshot: "bad" }
        : {
            snapshot: [
              ...(this.crowded
                ? Array.from({ length: 128 }, (_, index) => ({
                    role: "paragraph",
                    name: `Text ${index}`,
                    ref: `static${index}`,
                  }))
                : []),
              { role: "heading", name: "Fixture" },
              {
                role: "button",
                name:
                  this.changeIdentity && this.#snapshotCount > 1
                    ? "Changed"
                    : "Run",
                ref: "e1",
              },
              { role: "textbox", name: "Query", ref: "e2" },
              { role: "textbox", name: "Password", ref: "e3" },
              { role: "button", name: "Hidden", ref: "e4" },
              ...(this.includeComboboxes
                ? [
                    {
                      role: "combobox",
                      name: "Delivery speed",
                      ref: "e5",
                    },
                    {
                      role: "combobox",
                      name: "Search cities",
                      ref: "e6",
                    },
                    {
                      role: "textbox",
                      name: "Custom city",
                      ref: "e7",
                    },
                  ]
                : []),
            ],
          };
    }
    return { stdout: JSON.stringify(response), stderr: "" };
  }
}

function dom(
  ref: string,
  options: {
    tag: string;
    type?: string;
    autocomplete?: string;
    visible?: boolean;
    value?: string;
    optionsTruncated?: boolean;
    options?: Array<{
      value: string;
      label: string;
      selected: boolean;
      disabled: boolean;
    }>;
  },
) {
  return {
    ref,
    count: 1,
    visible: options.visible ?? true,
    tag: options.tag,
    type: options.type ?? "",
    id: "",
    fieldName: "",
    autocomplete: options.autocomplete ?? "",
    href: "",
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.optionsTruncated === undefined
      ? {}
      : { optionsTruncated: options.optionsTruncated }),
    ...(options.options === undefined ? {} : { options: options.options }),
  };
}

test("Playwright inspection finds and operates buttons after 128 static references", async () => {
  const runner = new FakePlaywrightRunner();
  runner.crowded = true;
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  try {
    const tab = await backend.open("crowded", "https://example.com/");
    const inspection = await backend.inspect("crowded", tab.tabId);
    const button = inspection.targets.find(({ name }) => name === "Run");
    assert.ok(
      button,
      "actionable button must survive static reference truncation",
    );
    assert.ok(inspection.targets.length <= 128);
    await backend.click(
      "crowded",
      tab.tabId,
      inspection.observationId,
      button.targetId,
    );
    assert.ok(runner.calls.some((args) => args[2] === "click"));
  } finally {
    await backend.close();
  }
});

test("Playwright inspection needs at most eight CLI round trips", async () => {
  const runner = new FakePlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
  try {
    const tab = await backend.open("fast", "https://example.com/");
    const before = runner.calls.length;
    await backend.inspect("fast", tab.tabId);
    assert.ok(
      runner.calls.length - before <= 8,
      `inspection used ${runner.calls.length - before} CLI round trips`,
    );
  } finally {
    await backend.close();
  }
});

for (const action of ["click", "type"] as const) {
  test(`Playwright rejects an old ${action} target after same-URL document replacement`, async () => {
    const runner = new FakePlaywrightRunner();
    const backend = new PlaywrightCliBrowserBackend({
      executable: "/opt/playwright-cli",
      runner,
      cwd: "/tmp/zenx-playwright",
    });
    try {
      const tab = await backend.open("reload", "https://example.com/");
      const inspection = await backend.inspect("reload", tab.tabId);
      const target = inspection.targets.find(
        ({ name }) => name === (action === "click" ? "Run" : "Query"),
      )!;
      runner.documentKey = "replacement-document";
      await assert.rejects(
        action === "click"
          ? backend.click(
              "reload",
              tab.tabId,
              inspection.observationId,
              target.targetId,
            )
          : backend.type(
              "reload",
              tab.tabId,
              inspection.observationId,
              target.targetId,
              "value",
              false,
            ),
        /stale|inspect again/u,
      );
      assert.equal(
        runner.calls.filter((args) => args[2] === "click" || args[2] === "fill")
          .length,
        0,
      );
    } finally {
      await backend.close();
    }
  });
}

for (const phase of ["snapshot", "screenshot"] as const) {
  test(`Playwright optimized inspection rejects document changes during ${phase}`, async () => {
    const runner = new FakePlaywrightRunner();
    const backend = new PlaywrightCliBrowserBackend({
      executable: "/opt/playwright-cli",
      runner,
      cwd: "/tmp/zenx-playwright",
    });
    try {
      const tab = await backend.open("changing", "https://example.com/");
      runner.onCommand = (command, args) => {
        if (
          phase === "snapshot"
            ? command === "snapshot"
            : command === "run-code" && args[3]?.includes("screenshot")
        ) {
          runner.documentKey = "replacement-document";
        }
      };
      await assert.rejects(
        backend.inspect("changing", tab.tabId),
        /page changed during/u,
      );
      runner.onCommand = undefined;
      const inspection = await backend.inspect("changing", tab.tabId);
      assert.ok(inspection.targets.some(({ name }) => name === "Run"));
    } finally {
      await backend.close();
    }
  });
}

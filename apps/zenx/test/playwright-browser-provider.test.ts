import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import type {
  ExternalProviderProcessResult,
  ExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";
import {
  PlaywrightCliBrowserBackend,
  playwrightSelectActionCode,
} from "../src/main/capabilities/playwright-browser-provider.js";

import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";

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
    assert.match(dispatched[0]![3]!, /state.documentKey/);
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
  assert.ok(runner.calls.some((args) => isAction(args, "click")));
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
  assert.equal(runner.calls.filter((args) => isAction(args, "fill")).length, 1);
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
  assert.equal(
    runner.calls.filter((args) => isAction(args, "click")).length,
    0,
  );
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
    identity: `native-${ref}`,
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
    assert.ok(runner.calls.some((args) => isAction(args, "click")));
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
        runner.calls.filter(
          (args) => isAction(args, "click") || isAction(args, "fill"),
        ).length,
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

function isAction(args: readonly string[], action: "click" | "fill"): boolean {
  return (
    args[2] === action ||
    (args[2] === "run-code" &&
      args[3]?.includes(`await handle.${action}(`) === true)
  );
}

class NativeHandle {
  disposed = false;
  constructor(
    readonly page: NativePage,
    readonly node: Node,
  ) {}
  async evaluate(callback: Function, argument?: unknown): Promise<any> {
    if (this.disposed) throw new Error("Handle disposed");
    const evaluate = this.page.dom.window.eval(`(${callback.toString()})`) as (
      node: Node,
      argument: unknown,
    ) => unknown;
    return evaluate(this.node, unwrapHandles(argument));
  }
  async isVisible(): Promise<boolean> {
    return this.node.isConnected && !(this.node as HTMLElement).hidden;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  async click(): Promise<void> {
    if (!this.node.isConnected) throw new Error("Element is not attached");
    (this.node as HTMLElement).click();
  }
  async fill(value: string): Promise<void> {
    if (!this.node.isConnected) throw new Error("Element is not attached");
    (this.node as HTMLInputElement).value = value;
  }
}

function unwrapHandles(value: unknown): any {
  if (value instanceof NativeHandle) {
    if (value.disposed) throw new Error("Handle disposed");
    return value.node;
  }
  if (Array.isArray(value)) return value.map(unwrapHandles);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, unwrapHandles(entry)]),
    );
  return value;
}

class NativePage {
  dom: JSDOM;
  beforeEvaluate?: (source: string) => void;
  constructor(html: string) {
    this.dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "https://example.com/",
    });
  }
  context() {
    return { pages: () => [this] };
  }
  async title() {
    return "Fixture";
  }
  url() {
    return "https://example.com/";
  }
  async evaluate(callback: Function, argument?: unknown) {
    this.beforeEvaluate?.(callback.toString());
    const evaluate = this.dom.window.eval(`(${callback.toString()})`) as (
      argument: unknown,
    ) => Node;
    return evaluate(unwrapHandles(argument));
  }
  async evaluateHandle(callback: Function) {
    return new NativeHandle(this, await this.evaluate(callback));
  }
  locator(selector: string) {
    const resolve = () =>
      this.dom.window.document.querySelector(
        `[data-ref="${selector.slice("aria-ref=".length)}"]`,
      );
    return {
      count: async () => (resolve() ? 1 : 0),
      elementHandle: async () =>
        resolve() ? new NativeHandle(this, resolve()!) : null,
    };
  }
  getByRole(role: string, options: { name: string }) {
    return {
      and: (locator: ReturnType<NativePage["locator"]>) => {
        const matching = async () => {
          const handle = await locator.elementHandle();
          if (!handle) return null;
          const element = handle.node as Element;
          const actualRole =
            element.getAttribute("role") ||
            (element.tagName === "INPUT" ? "textbox" : "button");
          const name =
            element.getAttribute("aria-label") || element.textContent || "";
          if (actualRole === role && name === options.name) return handle;
          await handle.dispose();
          return null;
        };
        return {
          count: async () => {
            const handle = await matching();
            if (handle) await handle.dispose();
            return handle ? 1 : 0;
          },
          elementHandle: matching,
        };
      },
    };
  }
  async run(code: string): Promise<any> {
    // Like playwright-cli, each call has a fresh VM with the same native Page.
    return await vm.runInNewContext(`(${code})(page)`, { page: this });
  }
  navigate(html: string) {
    this.dom.window.close();
    this.dom = new JSDOM(html, {
      runScripts: "outside-only",
      url: "https://example.com/",
    });
  }
}

class NativeIdentityRunner extends FakePlaywrightRunner {
  readonly page: NativePage;
  beforeAction?: () => void;
  constructor(html: string) {
    super();
    this.page = new NativePage(html);
  }
  override async run(
    executable: string,
    args: readonly string[],
    options: Parameters<FakePlaywrightRunner["run"]>[2],
  ) {
    const fallback = await super.run(executable, args, options);
    if (args[2] === "snapshot") {
      const snapshot = [
        ...this.page.dom.window.document.querySelectorAll("[data-ref]"),
      ].map((element) => ({
        role:
          element.getAttribute("role") ||
          (element.tagName === "INPUT" ? "textbox" : "button"),
        name: element.getAttribute("aria-label") || element.textContent || "",
        ref: element.getAttribute("data-ref")!,
      }));
      return { stdout: JSON.stringify({ snapshot }), stderr: "" };
    }
    if (args[2] === "run-code" && args[3]?.includes("Symbol.for")) {
      if (isAction(args, "click") || isAction(args, "fill"))
        this.beforeAction?.();
      return {
        stdout: JSON.stringify({
          result: JSON.stringify(await this.page.run(args[3])),
        }),
        stderr: "",
      };
    }
    return fallback;
  }
}

function nativeBackend(runner: NativeIdentityRunner) {
  return new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
  });
}

test("Playwright hidden captures preserve actual node identity across rename, reorder and changed ARIA refs", async () => {
  const runner = new NativeIdentityRunner(
    '<button data-ref="a">Run</button><input data-ref="b" value="before">',
  );
  const backend = nativeBackend(runner);
  try {
    const tab = await backend.open("native", "https://example.com/");
    const first = await backend.inspect("native", tab.tabId);
    const firstCapture = first[OBSERVATION_CAPTURE]!;
    const button = runner.page.dom.window.document.querySelector("button")!;
    button.textContent = "Renamed";
    button.setAttribute("data-ref", "new-ref");
    button.parentElement!.append(button);
    (
      runner.page.dom.window.document.querySelector("input") as HTMLInputElement
    ).value = "after";
    const second = await backend.inspect("native", tab.tabId);
    const secondCapture = second[OBSERVATION_CAPTURE]!;
    assert.equal(secondCapture.scopeKey, firstCapture.scopeKey);
    assert.equal(
      secondCapture.entries[1]!.identity,
      firstCapture.entries[0]!.identity,
    );
    assert.equal(
      secondCapture.entries[0]!.identity,
      firstCapture.entries[1]!.identity,
    );
    assert.equal(secondCapture.entries[0]!.value.value, "after");
    assert.notEqual(
      secondCapture.entries[1]!.value.targetId,
      firstCapture.entries[0]!.value.targetId,
    );
    await assert.rejects(
      async () => await firstCapture.assertCurrent!(),
      /stale/,
    );
    assert.equal(secondCapture.coverage.sourceComplete, null);
    assert.deepEqual(secondCapture.coverage.reasons, [
      "native-aria-depth-limit-12",
    ]);
    assert.equal(JSON.stringify(second).includes("scopeKey"), false);
    button.replaceWith(button.cloneNode(true));
    const third = await backend.inspect("native", tab.tabId);
    assert.notEqual(
      third[OBSERVATION_CAPTURE]!.entries[1]!.identity,
      secondCapture.entries[1]!.identity,
    );
    assert.equal(third[OBSERVATION_CAPTURE]!.scopeKey, secondCapture.scopeKey);
  } finally {
    await backend.close();
    runner.page.dom.window.close();
  }
});

test("Playwright rejects a clone under an unchanged ARIA ref and changed fingerprint on the same node", async () => {
  for (const mutation of ["clone", "name", "value", "checked"] as const) {
    const runner = new NativeIdentityRunner(
      '<input data-ref="a" aria-label="Query" value="before">',
    );
    const backend = nativeBackend(runner);
    try {
      const tab = await backend.open("native", "https://example.com/");
      const observed = await backend.inspect("native", tab.tabId);
      const input = runner.page.dom.window.document.querySelector("input")!;
      if (mutation === "clone") input.replaceWith(input.cloneNode(true));
      if (mutation === "name") input.setAttribute("aria-label", "Changed");
      if (mutation === "value") input.value = "changed";
      if (mutation === "checked") input.checked = true;
      await assert.rejects(
        backend.click(
          "native",
          tab.tabId,
          observed.observationId,
          observed.targets[0]!.targetId,
        ),
        /identity, visibility, or actions changed/,
      );
      assert.equal(
        runner.calls.some((args) => isAction(args, "click")),
        false,
      );
    } finally {
      await backend.close();
      runner.page.dom.window.close();
    }
  }
});

test("Playwright actions bind actual retained handles when a lookalike replaces the ref after revalidation", async () => {
  const runner = new NativeIdentityRunner('<button data-ref="a">Run</button>');
  const backend = nativeBackend(runner);
  try {
    const tab = await backend.open("native", "https://example.com/");
    const observed = await backend.inspect("native", tab.tabId);
    let clicked = false;
    runner.beforeAction = () => {
      const button = runner.page.dom.window.document.querySelector("button")!;
      const clone = button.cloneNode(true);
      clone.addEventListener("click", () => {
        clicked = true;
      });
      button.replaceWith(clone);
    };
    await assert.rejects(
      backend.click(
        "native",
        tab.tabId,
        observed.observationId,
        observed.targets[0]!.targetId,
      ),
      /target identity changed/,
    );
    assert.equal(clicked, false);
  } finally {
    await backend.close();
    runner.page.dom.window.close();
  }
});

test("Playwright document incarnations ignore page-controlled keys and remain stable across actions", async () => {
  const runner = new NativeIdentityRunner('<button data-ref="a">Run</button>');
  const backend = nativeBackend(runner);
  try {
    const tab = await backend.open("native", "https://example.com/");
    const first = await backend.inspect("native", tab.tabId);
    const scope = first[OBSERVATION_CAPTURE]!.scopeKey;
    await backend.click(
      "native",
      tab.tabId,
      first.observationId,
      first.targets[0]!.targetId,
    );
    await assert.rejects(
      async () => await first[OBSERVATION_CAPTURE]!.assertCurrent!(),
      /stale/,
    );
    const second = await backend.inspect("native", tab.tabId);
    assert.equal(second[OBSERVATION_CAPTURE]!.scopeKey, scope);
    assert.ok(second.documentVersion > first.documentVersion);
    runner.page.navigate('<button data-ref="a">Run</button>');
    runner.page.dom.window.name = "__zenx_tab_fixture";
    runner.page.dom.window.eval(
      "globalThis.__zenx_document_key = 'document-fixture'",
    );
    const probesBefore = runner.calls.length;
    await assert.rejects(
      async () => await second[OBSERVATION_CAPTURE]!.assertCurrent!(),
      /stale/,
    );
    assert.equal(
      runner.calls.length,
      probesBefore + 1,
      "external navigation probe must not recapture ARIA or screenshot",
    );
    const third = await backend.inspect("native", tab.tabId);
    assert.notEqual(third[OBSERVATION_CAPTURE]!.scopeKey, scope);
    assert.notEqual(
      third[OBSERVATION_CAPTURE]!.entries[0]!.identity,
      second[OBSERVATION_CAPTURE]!.entries[0]!.identity,
    );
  } finally {
    await backend.close();
    runner.page.dom.window.close();
  }
});

test("Playwright captures more than direct target/text limits and allocates actionable hidden targets", async () => {
  const runner = new NativeIdentityRunner(
    Array.from(
      { length: 150 },
      (_, index) =>
        `<button data-ref="b${index}">${index}:${"x".repeat(100)}</button>`,
    ).join(""),
  );
  const backend = nativeBackend(runner);
  try {
    const tab = await backend.open("native", "https://example.com/");
    const result = await backend.inspect("native", tab.tabId);
    const capture = result[OBSERVATION_CAPTURE]!;
    assert.equal(result.targets.length, 128);
    assert.equal(result.visibleText.length, 8000);
    assert.equal(capture.entries.length, 150);
    assert.ok(capture.text!.length > 8000);
    let clicked = false;
    runner.page.dom.window.document
      .querySelector('[data-ref="b149"]')!
      .addEventListener("click", () => {
        clicked = true;
      });
    await backend.click(
      "native",
      tab.tabId,
      result.observationId,
      capture.entries[149]!.value.targetId,
    );
    assert.equal(clicked, true);
  } finally {
    await backend.close();
    runner.page.dom.window.close();
  }
});

test("Playwright capture declares bounded omissions beyond 512 targets and 128k text", async () => {
  const runner = new NativeIdentityRunner(
    Array.from(
      { length: 514 },
      (_, index) => `<button data-ref="b${index}">${"x".repeat(300)}</button>`,
    ).join(""),
  );
  const backend = nativeBackend(runner);
  try {
    const tab = await backend.open("native", "https://example.com/");
    const result = await backend.inspect("native", tab.tabId);
    const capture = result[OBSERVATION_CAPTURE]!;
    assert.equal(capture.entries.length, 512);
    assert.equal(capture.coverage.itemTotal, 514);
    assert.equal(capture.coverage.textTotal, 514 * 300 + 513);
    assert.equal(capture.text!.length, 128000);
    assert.deepEqual(capture.coverage.reasons, [
      "native-aria-depth-limit-12",
      "capture-item-limit",
      "capture-text-limit",
    ]);
  } finally {
    await backend.close();
    runner.page.dom.window.close();
  }
});

for (const mutation of ["name", "value"] as const) {
  test(`Playwright final dispatch rejects same-node ${mutation} change after revalidation`, async () => {
    const runner = new NativeIdentityRunner(
      '<input data-ref="a" aria-label="Query" value="before">',
    );
    const backend = nativeBackend(runner);
    try {
      const tab = await backend.open("native", "https://example.com/");
      const observed = await backend.inspect("native", tab.tabId);
      runner.beforeAction = () => {
        const input = runner.page.dom.window.document.querySelector("input")!;
        if (mutation === "name") input.setAttribute("aria-label", "Changed");
        else input.value = "changed";
      };
      await assert.rejects(
        backend.click(
          "native",
          tab.tabId,
          observed.observationId,
          observed.targets[0]!.targetId,
        ),
        /semantics changed|fingerprint changed/,
      );
    } finally {
      await backend.close();
      runner.page.dom.window.close();
    }
  });
}

test("Playwright scroll rejects navigation between document probe and mutation callback", async () => {
  const runner = new NativeIdentityRunner('<button data-ref="a">Run</button>');
  const backend = nativeBackend(runner);
  try {
    const tab = await backend.open("native", "https://example.com/");
    const observed = await backend.inspect("native", tab.tabId);
    let scrolled = false;
    runner.page.beforeEvaluate = (source) => {
      if (!source.includes("window.scrollBy")) return;
      runner.page.beforeEvaluate = undefined;
      runner.page.navigate('<button data-ref="a">Run</button>');
      runner.page.dom.window.scrollBy = () => {
        scrolled = true;
      };
    };
    await assert.rejects(
      backend.scroll("native", tab.tabId, observed.observationId, "down", 600),
      /document changed/,
    );
    assert.equal(scrolled, false);
  } finally {
    await backend.close();
    runner.page.dom.window.close();
  }
});

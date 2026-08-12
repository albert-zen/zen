import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExternalProviderProcessResult,
  ExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";
import { PlaywrightCliBrowserBackend } from "../src/main/capabilities/playwright-browser-provider.js";

test("Playwright provider runs an isolated JSON-only observe/action slice", async () => {
  const runner = new FakePlaywrightRunner();
  const backend = new PlaywrightCliBrowserBackend({
    executable: "/opt/playwright-cli",
    runner,
    cwd: "/tmp/zenx-playwright",
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

class FakePlaywrightRunner implements ExternalProviderProcessRunner {
  readonly calls: string[][] = [];
  url = "https://example.com/";
  invalidSnapshot = false;
  changeIdentity = false;
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
    _options: { timeoutMs: number },
  ): Promise<ExternalProviderProcessResult> {
    this.calls.push([...args]);
    const command = args[2];
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
        result:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
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
            ]),
          }
        : {
            result: JSON.stringify([
              {
                index: 0,
                title: "Fixture",
                url: this.url,
                current: true,
              },
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
  };
}

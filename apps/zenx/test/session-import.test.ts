import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionImportDialog } from "../src/renderer/src/SessionImportDialog.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
import {
  parseSessionImport,
  previewSessionImport,
} from "../../../src/protocol/session-import.js";
import {
  commandPhase,
  commandStatus,
  isTerminalCommandPhase,
} from "../src/renderer/src/tool-presentation.js";
import type {
  ModelSummary,
  CommandItem,
} from "../src/protocol-client/index.js";
import { i18n } from "../src/renderer/src/i18n.js";

const model: ModelSummary = {
  id: encodeModelKey({ providerProfileId: "local", modelId: "test" }),
  model: "test",
  displayName: "Local test",
  description: "",
  isDefault: true,
  hidden: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
  inputModalities: ["text"],
  supportsPersonality: false,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
};
const selected = (text = "hello") =>
  [
    {
      type: "session_meta",
      payload: { id: "source", cwd: "/source-only", cli_version: "0.146.0" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    },
  ]
    .map((entry) =>
      JSON.stringify({ timestamp: "2026-10-12T00:00:00Z", ...entry }),
    )
    .join("\n");
const report = (contents: string) =>
  previewSessionImport(
    parseSessionImport({ format: "codex-rollout-0.146.0", contents }),
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function domTest(
  run: (h: {
    select(contents: string, name?: string): Promise<void>;
    click(text: string): Promise<void>;
    requests: { method: string; params: Record<string, unknown> }[];
    setRequest(
      fn: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    ): void;
    setOpen(fn: () => Promise<void>): void;
    setModels(models: ModelSummary[]): Promise<void>;
    closed(): number;
  }) => Promise<void>,
) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  await i18n.changeLanguage("en");
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let closed = 0;
  let open = async () => {};
  let request = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> =>
    method.endsWith("preview")
      ? report(String(params.contents))
      : { thread: { id: "imported" }, status: "imported" };
  Object.assign(window, {
    zenx: {
      protocol: {
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          return request(method, params);
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  let currentModels = [model];
  const render = () =>
    root.render(
      React.createElement(SessionImportDialog, {
        models: currentModels,
        initialCwd: "/chosen-local",
        onClose: () => {
          closed++;
        },
        onImported: async () => open(),
      }),
    );
  try {
    await act(async () => render());
    await run({
      setModels: async (models) => {
        currentModels = models;
        await act(async () => render());
      },
      requests,
      setRequest: (fn) => {
        request = fn;
      },
      setOpen: (fn) => {
        open = fn;
      },
      closed: () => closed,
      select: async (contents, name = "selected.jsonl") => {
        const input =
          document.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [
            {
              name,
              size: Buffer.byteLength(contents),
              arrayBuffer: async () =>
                new TextEncoder().encode(contents).buffer,
            },
          ],
        });
        await act(async () => {
          input.dispatchEvent(
            new dom.window.Event("change", { bubbles: true }),
          );
        });
      },
      click: async (text) => {
        const button = [...document.querySelectorAll("button")].find(
          (entry) => entry.textContent === text,
        );
        assert(button, text);
        await act(async () => button.click());
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
}

test("import preview requires explicit local confirmation and rapid repeat clicks submit once", async () =>
  domTest(async (h) => {
    const reply = deferred<unknown>();
    h.setRequest(async (method, params) =>
      method.endsWith("preview")
        ? report(String(params.contents))
        : reply.promise,
    );
    await h.select(selected());
    assert.equal(h.requests.length, 1);
    assert(document.body.textContent?.includes("/source-only"));
    await h.click("Import and open");
    await h.click("Importing…");
    assert.equal(
      h.requests.filter((entry) => entry.method === "zen/thread/import").length,
      1,
    );
    const submitted = h.requests[1]!.params.configuration as Record<
      string,
      unknown
    >;
    assert.equal(submitted.cwd, "/chosen-local");
    assert.equal(submitted.sandbox, "read-only");
    assert.deepEqual(submitted.selection, {
      providerProfileId: "local",
      modelId: "test",
      reasoningEffort: "medium",
    });
    assert.equal(
      document.querySelector<HTMLButtonElement>("header button")?.disabled,
      true,
    );
    await act(async () =>
      reply.resolve({ thread: { id: "imported" }, status: "imported" }),
    );
    assert.equal(h.closed(), 1);
  }));

test("newer file selection owns preview and stale completion cannot replace it", async () =>
  domTest(async (h) => {
    const stale = deferred<unknown>();
    h.setRequest(async (_method, params) =>
      String(params.contents).includes("older")
        ? stale.promise
        : report(String(params.contents)),
    );
    await h.select(selected("older"), "old.jsonl");
    await h.select(selected("newer"), "new.jsonl");
    await act(async () => stale.resolve(report(selected("older"))));
    assert(document.body.textContent?.includes("newer"));
    assert(!document.body.textContent?.includes("older"));
    assert.equal(
      h.requests.filter((entry) => entry.method === "zen/thread/import").length,
      0,
    );
    await h.click("Cancel");
    assert.equal(h.closed(), 1);
  }));

test("preview failure leaves import disabled, and navigation failure retries opening without reimport", async () =>
  domTest(async (h) => {
    await h.select("malformed");
    assert(document.querySelector('[role="alert"]'));
    assert.equal(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Import and open",
      )?.disabled,
      true,
    );
    await h.select(selected());
    h.setOpen(async () => {
      throw new Error("navigation unavailable");
    });
    await h.click("Import and open");
    assert(
      document.body.textContent?.includes(
        "Imported. Open the saved conversation",
      ),
    );
    assert(document.body.textContent?.includes("navigation unavailable"));
    h.setOpen(async () => {});
    await h.click("Open imported conversation");
    assert.equal(
      h.requests.filter((entry) => entry.method === "zen/thread/import").length,
      1,
    );
    assert.equal(h.closed(), 1);
  }));

test("historical tool result is terminal with unknown outcome, never displayed as a new failure or success", () => {
  const item = {
    type: "commandExecution",
    status: "failed",
    contentType: "zen.imported-tool-result.v1",
    exitCode: null,
  } as CommandItem;
  assert.equal(commandPhase(item), "imported");
  assert.equal(isTerminalCommandPhase(commandPhase(item)), true);
  assert.match(commandStatus(item), /Historical result/);
});

test("saved import can reopen after its creation model disappears", async () =>
  domTest(async (h) => {
    let opens = 0;
    h.setOpen(async () => {
      opens++;
      if (opens === 1) throw new Error("open failed");
    });
    await h.select(selected());
    await h.click("Import and open");
    await h.setModels([]);
    const button = [...document.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Open imported conversation",
    )!;
    assert.equal(button.disabled, false);
    await h.click("Open imported conversation");
    assert.equal(opens, 2);
    assert.equal(
      h.requests.filter((entry) => entry.method === "zen/thread/import").length,
      1,
    );
    assert.equal(h.closed(), 1);
  }));

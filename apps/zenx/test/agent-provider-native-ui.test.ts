import "./dom-primitives.js";
import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentProviderService } from "../src/main/agent-providers/service.js";
import { OpenCodeAgentProviderAdapter } from "../src/main/agent-providers/opencode-adapter.js";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentProviderInstance,
  AgentProvidersApi,
} from "../src/main/agent-providers/types.js";
import { ExternalAgentSession } from "../src/renderer/src/agent-providers-ui.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
const { act, createElement: h } = React;
Object.assign(globalThis, { React });
async function mounted(
  run: (ctx: {
    root: ReturnType<typeof createRoot>;
    dom: JSDOM;
    render(element: React.ReactNode): Promise<void>;
  }) => Promise<void>,
  service: AgentProvidersApi,
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    MouseEvent: globalThis.MouseEvent,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", {
    value: { agentProviders: service },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run({
      root,
      dom,
      render: async (element) => {
        await act(async () => root.render(element));
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, saved);
    dom.window.close();
  }
}
function button(label: string) {
  const value = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (entry) =>
      entry.textContent?.trim() === label ||
      entry.getAttribute("aria-label") === label,
  );
  assert.ok(value, `Missing button ${label}`);
  return value;
}
async function input(dom: JSDOM, selector: string, text: string) {
  const target = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  assert.ok(target);
  const prototype =
    target.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, text);
  await act(async () =>
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true })),
  );
}
function Session({
  instance,
  id,
  workspace,
}: {
  instance: AgentProviderInstance;
  id: string;
  workspace: string;
}) {
  const [composer, setComposer] = React.useState(emptyComposerState());
  return h(ExternalAgentSession, {
    instance,
    sessionId: id,
    composer,
    onComposerChange: setComposer,
    onCreated: () => {},
    workspace,
    permissionMode: "danger-full-access",
  });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Native UI condition did not settle");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}
test("native question preceding HTTP admission remains visible through the real Host and renderer", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-ui-question-"));
  const filename = path.join(home, "server.mjs");
  const source = await readFile(
    new URL("./fixtures/opencode-app-server.mjs", import.meta.url),
    "utf8",
  );
  // Valid native peer timing: SSE and HTTP receipts use independent transports.
  const release = path.join(home, "release-admission");
  const delayed = source.replace(
    "res.writeHead(204).end();",
    `const admit = () => fs.existsSync(${JSON.stringify(release)}) ? res.writeHead(204).end() : setTimeout(admit, 10); admit();`,
  );
  assert.notEqual(delayed, source);
  await writeFile(filename, delayed);
  const native = new OpenCodeAgentProviderAdapter({
    processCwd: home,
    spawnProcess: ((
      _command: string,
      args: readonly string[] = [],
      options: SpawnOptions = {},
    ) =>
      spawn(
        process.execPath,
        [filename, home, "normal", ...args],
        options,
      )) as unknown as typeof spawn,
  });
  const host = new AgentProviderService(
    home,
    () => native,
    async () => [],
  );
  let admitted = false;
  const send = host.send.bind(host);
  host.send = async (...args) => {
    await send(...args);
    admitted = true;
  };
  const instance = await host.save({
    id: "opencode-native",
    kind: "opencode",
    name: "OpenCode",
  });
  try {
    const created = await host.create({
      providerInstanceId: instance.id,
      cwd: home,
      permissionMode: "danger-full-access",
    });
    const message = "OpenCode requested structured user input.";
    let sawNativeIssue = false;
    host.onEvent((event) => {
      if (event.type === "error" && event.message.includes(message))
        sawNativeIssue = true;
    });
    await mounted(
      async ({ render, dom }) => {
        await render(
          h(Session, { instance, id: created.binding.id, workspace: home }),
        );
        await until(() => document.querySelector("textarea") !== null);
        await input(dom, "textarea", "question");
        await until(() => !button("Send").disabled);
        await act(async () => button("Send").click());
        await until(
          () => sawNativeIssue && document.body.textContent!.includes(message),
        );
        assert.equal(admitted, false);
        assert.ok(
          sawNativeIssue,
          "real native SSE issue traversed the Host before the HTTP admission receipt",
        );
        assert.ok(
          document.body.textContent!.includes(message),
          "issue initially reaches the real session renderer",
        );
        await writeFile(release, "yes");
        await until(() => admitted);
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 180)),
        );
        assert.ok(
          document.body.textContent!.includes(message),
          "successful real native prompt admission and history read must not erase the unsupported question",
        );
      },
      host as unknown as AgentProvidersApi,
    );
  } finally {
    await host.dispose();
  }
});

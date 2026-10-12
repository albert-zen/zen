import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { TriggersPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("same-event-loop Confirm must be single-flight and a retired result must not bind a new draft", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const calls: string[] = [];
  let resolveCreate!: (value: unknown) => void;
  const creation = new Promise<unknown>((resolve) => {
    resolveCreate = resolve;
  });
  const preview = {
    workspace: "/configured",
    resolvedWorkspace: "/configured",
    model: "model",
    modelId: "model",
    providerProfileId: "fake",
    reasoningEffort: null,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    processEpoch: "epoch",
    revision: 1,
  };
  const sdk = {
    context: {},
    commands: {
      execute: async (id: string) => {
        calls.push(id);
        if (id === "list") return { triggers: [], history: [] };
        if (id === "threads") return { threads: [] };
        if (id === "workspaces") return { workspaces: ["/configured"] };
        if (id === "preview-target") return preview;
        if (id === "create-target") return await creation;
        throw Error(id);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const click = async (label: string) =>
    await React.act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label,
      );
      assert(button, label);
      button.click();
    });
  try {
    await React.act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    await click("New trigger");
    await React.act(async () => {
      const select = [...document.querySelectorAll("select")].find((element) =>
        [...element.options].some(
          (option) => option.textContent === "/configured",
        ),
      )!;
      assert(select, "workspace native select bridge");
      select.value = "value:/configured";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await click("Review Thread permissions");
    const confirm = [...document.querySelectorAll("button")].find((element) =>
      element.textContent?.includes("Confirm settings and create"),
    )!;
    await React.act(async () => {
      confirm.click();
      confirm.click();
    });
    assert.equal(
      calls.filter((id) => id === "create-target").length,
      1,
      "same event loop must not create two high-permission idle Threads",
    );
    await click("Cancel"); // Cancel the confirmation or form; old operation may already have created a Thread.
    await click("New trigger");
    await React.act(async () =>
      resolveCreate({ threadId: "old-A", effective: preview }),
    );
    assert.doesNotMatch(
      document.querySelector("form.trigger-editor")?.textContent ?? "",
      /Dedicated Thread old-A created with/,
    );
    assert.match(
      document.body.textContent ?? "",
      /old-A/,
      "retired Host side effect must still be findable",
    );
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("same-event-loop Save is single-flight; Cancel/New fences an old saved definition", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  let creations = 0;
  let resolveSave!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    resolveSave = resolve;
  });
  const sdk = {
    context: {},
    commands: {
      execute: async (id: string) => {
        if (id === "list") return { triggers: [], history: [] };
        if (id === "threads")
          return {
            threads: [
              {
                threadId: "target",
                shortId: "target",
                name: "Existing",
                cwd: "/work",
                archived: false,
                status: "idle",
              },
            ],
          };
        if (id === "workspaces") return { workspaces: [] };
        if (id === "create") {
          creations++;
          return await pending;
        }
        throw Error(id);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const fill = async (
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) =>
    React.act(async () => {
      const proto =
        element instanceof dom.window.HTMLTextAreaElement
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await React.act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    await React.act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "New trigger")!
        .click(),
    );
    await React.act(async () => {
      const native = [...document.querySelectorAll("select")].find((element) =>
        [...element.options].some((option) => option.value === "value:target"),
      )!;
      native.value = "value:target";
      native.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const form = document.querySelector("form.trigger-editor")!;
    await fill(form.querySelector("input:not([type])")!, "Same click task");
    await fill(form.querySelector("textarea")!, "Safe fake Provider task");
    await React.act(async () => {
      const save = form.querySelector<HTMLButtonElement>(
        "button[type=submit]",
      )!;
      save.click();
      save.click();
    });
    assert.equal(
      creations,
      1,
      "one form gesture must not install two active timers",
    );
    await React.act(async () =>
      [...form.querySelectorAll("button")]
        .find((b) => b.textContent === "Cancel")!
        .click(),
    );
    await React.act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "New trigger")!
        .click(),
    );
    await React.act(async () => resolveSave({ id: "old-trigger" }));
    assert.match(document.body.textContent ?? "", /old-trigger/);
    assert.ok(
      document.querySelector("form.trigger-editor"),
      "old result must not close the new form",
    );
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("late preview of the same workspace cannot overwrite the next draft or clear its pending state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const resolves: Array<(value: unknown) => void> = [];
  const preview = (modelId: string) => ({
    workspace: "/configured",
    resolvedWorkspace: "/configured",
    model: modelId,
    modelId,
    providerProfileId: "fake",
    reasoningEffort: null,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    processEpoch: "epoch",
    revision: 1,
  });
  const sdk = {
    context: {},
    commands: {
      execute: async (id: string) => {
        if (id === "list") return { triggers: [], history: [] };
        if (id === "threads") return { threads: [] };
        if (id === "workspaces") return { workspaces: ["/configured"] };
        if (id === "preview-target")
          return await new Promise<unknown>((resolve) => {
            resolves.push(resolve);
          });
        throw Error(id);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const click = async (name: string, scope: ParentNode = document) =>
    React.act(async () => {
      const button = [...scope.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === name,
      );
      assert(button, name);
      button.click();
    });
  const selectWorkspace = async () =>
    React.act(async () => {
      const native = [...document.querySelectorAll("select")].find((element) =>
        [...element.options].some(
          (option) => option.value === "value:/configured",
        ),
      )!;
      native.value = "value:/configured";
      native.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  try {
    await React.act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    await click("New trigger");
    await selectWorkspace();
    await click("Review Thread permissions");
    assert.equal(resolves.length, 1);
    await click("Cancel", document.querySelector("form.trigger-editor")!);
    await click("New trigger");
    await selectWorkspace();
    await click("Review Thread permissions");
    assert.equal(resolves.length, 2);
    await React.act(async () => resolves[0]!(preview("old-A")));
    assert.equal(
      document.querySelector(
        "[aria-label='Confirm dedicated Thread settings']",
      ),
      null,
    );
    assert.equal(
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Review Thread permissions",
      )?.disabled,
      true,
      "old finally cannot unlock new preview",
    );
    await React.act(async () => resolves[1]!(preview("new-B")));
    assert.match(
      document.querySelector("[aria-label='Confirm dedicated Thread settings']")
        ?.textContent ?? "",
      /new-B/,
    );
    assert.doesNotMatch(
      document.querySelector("[aria-label='Confirm dedicated Thread settings']")
        ?.textContent ?? "",
      /old-A/,
    );
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("a confirmed new idle Thread is selected only after Host discovery supplies its picker option", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const preview = {
    workspace: "/configured",
    resolvedWorkspace: "/configured",
    model: "model",
    modelId: "model",
    providerProfileId: "fake",
    reasoningEffort: null,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    processEpoch: "epoch",
    revision: 1,
  };
  let created = false;
  const sdk = {
    context: {},
    commands: {
      execute: async (id: string) => {
        if (id === "list") return { triggers: [], history: [] };
        if (id === "threads")
          return {
            threads: created
              ? [
                  {
                    threadId: "new-id",
                    shortId: "new-id",
                    name: "Idle",
                    cwd: "/configured",
                    archived: false,
                    status: "idle",
                  },
                ]
              : [],
          };
        if (id === "workspaces") return { workspaces: ["/configured"] };
        if (id === "preview-target") return preview;
        if (id === "create-target") {
          created = true;
          return { threadId: "new-id", effective: preview };
        }
        throw Error(id);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const click = async (name: string) =>
    React.act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === name,
      );
      assert(button, name);
      button.click();
    });
  try {
    await React.act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    await click("New trigger");
    await React.act(async () => {
      const native = [...document.querySelectorAll("select")].find((element) =>
        [...element.options].some(
          (option) => option.value === "value:/configured",
        ),
      )!;
      native.value = "value:/configured";
      native.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await click("Review Thread permissions");
    await click("Confirm settings and create dedicated Thread");
    assert.equal(
      [...document.querySelectorAll("form [role=combobox]")]
        .find((element) => element.getAttribute("data-value") === "new-id")
        ?.textContent?.includes("Idle"),
      true,
    );
    assert.match(
      document.body.textContent ?? "",
      /Dedicated Thread new-id created/,
    );
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

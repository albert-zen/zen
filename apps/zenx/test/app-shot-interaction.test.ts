import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AppShotButton } from "../src/renderer/src/AppShotButton.js";
import type { AppShotApi, AppShotEvent } from "../src/app-shot.js";
import type { ZenXImageDraft } from "../src/main/image-attachments.js";
import { i18n } from "../src/renderer/src/i18n.js";

const shot: ZenXImageDraft = {
  id: "shot",
  name: "Example.png",
  appShotContext: "Window: Example\nScreenshot only",
  attachment: {
    type: "attachment",
    sha256: "b".repeat(64),
    mediaType: "image/png",
    width: 1,
    height: 1,
    byteLength: 4,
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  run: (state: {
    api: AppShotApi;
    click(label: string): Promise<void>;
    attached: ZenXImageDraft[];
    emit(event: AppShotEvent): void;
    render(disabled?: boolean, key?: string): Promise<void>;
    armed(): string | null;
    disarmed: string[];
  }) => Promise<void>,
) {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://localhost",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    URL: dom.window.URL,
    Blob: dom.window.Blob,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window.URL, {
    createObjectURL: () => "blob:app-shot",
    revokeObjectURL: () => {},
  });
  const attached: ZenXImageDraft[] = [];
  const disarmed: string[] = [];
  let listener: (event: AppShotEvent) => void = () => {};
  let armed: string | null = null;
  const api: AppShotApi = {
    list: async () => [{ id: "source", title: "Example" }],
    capture: async () => shot,
    read: async () => new Uint8Array([1, 2, 3, 4]),
    attach: async (id) =>
      id === "second" ? { ...shot, id: "second", name: "Second.png" } : shot,
    discard: async () => {},
    arm: async (token) => {
      armed = token;
      return "⌘⇧2";
    },
    disarm: async (token) => {
      disarmed.push(token);
      if (armed === token) armed = null;
    },
    onCapture: (callback) => {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
  };
  Object.assign(dom.window, {
    zenx: {
      platform: "darwin",
      appShot: api,
      imageAttachments: { read: async () => new Uint8Array([1, 2, 3, 4]) },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const render = async (disabled = false, key = "one") => {
    await act(async () =>
      root.render(
        React.createElement(
          "div",
          { className: "thread-view" },
          React.createElement(AppShotButton, {
            key,
            disabled,
            api,
            onAttach: (image) => attached.push(image),
          }),
        ),
      ),
    );
  };
  const click = async (label: string) => {
    const element = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent === label,
    );
    assert.ok(element, `Missing button ${label}`);
    await act(async () => element.click());
  };
  try {
    await render();
    await run({
      api,
      click,
      attached,
      emit: (event) => listener(event),
      render,
      armed: () => armed,
      disarmed,
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

test("App Shot capture is reviewed and attached only by explicit click", async () => {
  await fixture(async ({ click, attached }) => {
    await click("App Shot");
    await click("Example");
    assert.equal(attached.length, 0);
    assert.match(document.body.textContent!, /Screenshot only/);
    await click("Attach to draft");
    assert.deepEqual(attached, [shot]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});
test("cancelled, disabled and replaced composer captures cannot attach later", async () => {
  await fixture(async ({ api, click, attached, render }) => {
    const pending = deferred<ZenXImageDraft>();
    api.capture = async () => pending.promise;
    await click("App Shot");
    await click("Example");
    await click("Close App Shot");
    await act(async () => pending.resolve(shot));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(attached.length, 0);
    const second = deferred<ZenXImageDraft>();
    api.capture = async () => second.promise;
    await click("App Shot");
    await click("Example");
    await render(false, "replacement");
    await act(async () => second.resolve(shot));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(attached.length, 0);
    await click("App Shot");
    await render(true, "replacement");
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});
test("opt-in shortcut is composer-scoped and its capture still requires review", async () => {
  await fixture(async ({ click, attached, emit, armed, disarmed, render }) => {
    await click("App Shot");
    const checkbox = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][1]!;
    await act(async () => checkbox.click());
    const token = armed();
    assert.ok(token);
    await click("Close App Shot");
    await act(async () => emit({ token, image: shot }));
    assert.equal(attached.length, 0);
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => emit({ token, disarmed: true }));
    assert.equal(
      [
        ...document.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ].at(-1)!.checked,
      false,
    );
    await render(false, "new");
    assert.ok(disarmed.includes(token));
  });
});

test("repeated shortcut captures remain ordered for review instead of replacing a preview", async () => {
  await fixture(async ({ click, attached, emit, armed }) => {
    await click("App Shot");
    const checkbox = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][1]!;
    await act(async () => checkbox.click());
    const token = armed()!;
    await click("Close App Shot");
    const second = { ...shot, id: "second", name: "Second.png" };
    await act(async () => {
      emit({ token, image: shot });
      emit({ token, image: second });
    });
    assert.equal(attached.length, 0);
    assert.match(document.body.textContent!, /1 more captures/);
    await click("Attach to draft");
    assert.deepEqual(attached, [shot]);
    assert.ok(document.querySelector('[role="dialog"]'));
    await click("Attach to draft");
    assert.deepEqual(attached, [shot, second]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});

test("locale updates keep an armed shortcut and image preview can expand", async () => {
  await fixture(async ({ click, armed }) => {
    await click("App Shot");
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ][1]!.click(),
    );
    const token = armed();
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    assert.equal(armed(), token);
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    await click("Example");
    await click("Preview Example.png");
    assert.ok(document.querySelector(".app-shot-preview.is-expanded"));
    await click("Preview Example.png");
    assert.equal(document.querySelector(".app-shot-preview.is-expanded"), null);
  });
});

test("a repeated shortcut cannot supersede an explicit attach in flight", async () => {
  await fixture(async ({ api, click, attached, emit, armed }) => {
    await click("App Shot");
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ][1]!.click(),
    );
    const token = armed()!;
    await click("Example");
    const pendingAttach = deferred<ZenXImageDraft>();
    api.attach = async () => pendingAttach.promise;
    await click("Attach to draft");
    await act(async () =>
      emit({ token, image: { ...shot, id: "second", name: "Second.png" } }),
    );
    await act(async () => pendingAttach.resolve(shot));
    assert.deepEqual(attached, [shot]);
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(document.querySelector('[aria-label="Preview Second.png"]'));
  });
});

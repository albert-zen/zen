import {
  appShotKeyChordAccelerator,
  type AppShotKeyChord,
} from "../src/app-shot-key-chord.js";
import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AppShotButton } from "../src/renderer/src/AppShotButton.js";
import { isAppShotShortcutKind } from "../src/app-shot.js";
import type {
  AppShotApi,
  AppShotEvent,
  AppShotShortcutKind,
} from "../src/app-shot.js";
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
    abandoned: string[];
    discarded: string[];
    emit(event: AppShotEvent): void;
    render(
      disabled?: boolean,
      key?: string,
      additional?: boolean,
    ): Promise<void>;
    armed(): string | null;
    disarmed: string[];
    armRequests: Array<{
      token: string;
      kind?: AppShotShortcutKind;
      chord?: AppShotKeyChord;
      includeAccessibility: boolean;
    }>;
    calls: string[];
  }) => Promise<void>,
  platform = "darwin",
  setup?: (dom: JSDOM) => void,
) {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://localhost",
  });
  setup?.(dom);
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
  const abandoned: string[] = [];
  const discarded: string[] = [];
  const disarmed: string[] = [];
  const armRequests: Array<{
    token: string;
    kind?: AppShotShortcutKind;
    chord?: AppShotKeyChord;
    includeAccessibility: boolean;
  }> = [];
  const calls: string[] = [];
  const listeners = new Set<(event: AppShotEvent) => void>();
  let armed: string | null = null;
  let recordingPermit: string | null = null;
  const api: AppShotApi = {
    configuration: async () => ({ nativeForeground: false }),
    beginRecording: async (token) => {
      if (armed)
        throw new Error(
          "Disable the active App Shot shortcut in its Composer before recording.",
        );
      if (recordingPermit) throw new Error("Another Composer is recording.");
      recordingPermit = token;
    },
    endRecording: async (token) => {
      if (recordingPermit === token) recordingPermit = null;
    },
    list: async () => {
      calls.push("list");
      return [{ id: "source", title: "Example" }];
    },
    capture: async () => {
      calls.push("capture");
      return shot;
    },
    read: async () => {
      calls.push("read");
      return new Uint8Array([1, 2, 3, 4]);
    },
    attach: async (id) => {
      calls.push("attach");
      return id === "second"
        ? { ...shot, id: "second", name: "Second.png" }
        : shot;
    },
    discard: async (id) => {
      discarded.push(id);
    },
    arm: async (token, includeAccessibility, kind, chord) => {
      if (recordingPermit) throw new Error("Finish or cancel recording first.");
      armRequests.push({ token, kind, chord, includeAccessibility });
      armed = token;
      return "⌘⇧2";
    },
    disarm: async (token) => {
      disarmed.push(token);
      if (armed === token) armed = null;
    },
    onCapture: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  Object.assign(dom.window, {
    zenx: {
      platform,
      appShot: api,
      imageAttachments: {
        read: async () => new Uint8Array([1, 2, 3, 4]),
        abandon: async (ids: string[]) => {
          abandoned.push(...ids);
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const render = async (disabled = false, key = "one", additional = false) => {
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
          additional
            ? React.createElement(AppShotButton, {
                key: "other-composer",
                disabled: false,
                api,
                onAttach: (image) => attached.push(image),
              })
            : null,
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
      abandoned,
      discarded,
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
      render,
      armed: () => armed,
      disarmed,
      armRequests,
      calls,
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

function shortcutCheckbox(): HTMLInputElement {
  const checkbox = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].at(-1);
  assert.ok(checkbox);
  return checkbox;
}

test("Windows defaults to both Shift but requires explicit enable", async () => {
  await fixture(async ({ click, armed, armRequests }) => {
    assert.equal(armed(), null);
    assert.equal(armRequests.length, 0);
    await click("App Shot");
    const both = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="both-shift"]',
    )!;
    assert.equal(both.checked, true);
    assert.equal(shortcutCheckbox().checked, false);
    await act(async () => shortcutCheckbox().click());
    assert.equal(armRequests[0]?.kind, "both-shift");
    assert.match(document.body.textContent!, /not a double tap/);
    assert.match(document.body.textContent!, /not reserved/);
    assert.match(document.body.textContent!, /already held/);
    await act(async () => shortcutCheckbox().click());
    assert.equal(armed(), null);
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="radio"][value="chord"]')!
        .click(),
    );
    await act(async () => shortcutCheckbox().click());
    assert.equal(armRequests[1]?.kind, "chord");
  }, "win32");
});

test("Linux exposes only the chord and its event opens an explicit chooser", async () => {
  await fixture(async ({ api, click, armed, emit, armRequests, attached }) => {
    let lists = 0;
    const list = api.list;
    api.list = async () => {
      lists++;
      return list();
    };
    await click("App Shot");
    assert.equal(
      document.querySelector('input[type="radio"][value="both-shift"]'),
      null,
    );
    assert.equal(
      document.querySelector<HTMLInputElement>(
        'input[type="radio"][value="chord"]',
      )!.checked,
      true,
    );
    assert.match(document.body.textContent!, /does not capture the foreground/);
    await act(async () => shortcutCheckbox().click());
    assert.equal(armRequests[0]?.kind, "chord");
    const token = armed()!;
    await click("Close App Shot");
    await act(async () => emit({ token, openPicker: true }));
    assert.equal(lists, 2);
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.deepEqual(attached, []);
    await click("Example");
    await act(async () => emit({ token, openPicker: true }));
    assert.equal(lists, 2);
    assert.ok(document.querySelector('[aria-label="Preview Example.png"]'));
    assert.deepEqual(attached, []);
  }, "linux");
});

test("held-at-enable capture does not erase shortcut startup state or skip review", async () => {
  await fixture(async ({ api, click, emit, attached }) => {
    const arm = api.arm;
    api.arm = async (token, includeAccessibility, kind) => {
      const result = arm(token, includeAccessibility, kind);
      emit({ token, image: shot });
      return result;
    };
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutCheckbox().checked, true);
    assert.ok(document.querySelector('[aria-label="Preview Example.png"]'));
    assert.deepEqual(attached, []);
    await click("Attach to draft");
    assert.deepEqual(attached, [shot]);
  });
});

test("a pending shortcut can be disabled before startup completes", async () => {
  await fixture(async ({ api, click, disarmed }) => {
    const ready = deferred<string>();
    api.arm = async () => ready.promise;
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutCheckbox().checked, true);
    assert.equal(shortcutCheckbox().disabled, false);
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutCheckbox().checked, false);
    assert.equal(disarmed.length, 1);
    await act(async () => ready.resolve("Left Shift + Right Shift"));
    assert.equal(shortcutCheckbox().checked, false);
  });
});

test("disabled composer fences a late shortcut startup result", async () => {
  await fixture(async ({ api, click, render, disarmed }) => {
    const ready = deferred<string>();
    api.arm = async () => ready.promise;
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    await render(true);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(disarmed.length, 1);
    await act(async () => ready.resolve("Left Shift + Right Shift"));
    await render(false);
    await click("App Shot");
    assert.equal(shortcutCheckbox().checked, false);
  });
});

test("native failure visibly disables the shortcut even when review was closed", async () => {
  await fixture(async ({ click, armed, emit }) => {
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    const token = armed()!;
    await click("Close App Shot");
    await act(async () =>
      emit({ token, disarmed: true, error: "Native helper stopped" }),
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(shortcutCheckbox().checked, false);
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Native helper stopped/,
    );
  });
});

test("startup rejection leaves an unchecked preference and visible error", async () => {
  await fixture(async ({ api, click }) => {
    api.arm = async () => {
      throw new Error("Shortcut unavailable");
    };
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutCheckbox().checked, false);
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Shortcut unavailable/,
    );
  });
});

test("Niri shows manual setup without implying the action reserves its keys", async () => {
  await fixture(async ({ api, render, click, armed, attached }) => {
    api.configuration = async () => ({
      nativeForeground: true,
      niriBinding: 'Ctrl+Shift+2 repeat=false { spawn "gdbus"; }',
    });
    await render(false, "niri");
    await click("App Shot");
    assert.match(document.body.textContent!, /Enable Niri capture action/);
    assert.match(document.body.textContent!, /does not reserve keys/);
    assert.match(document.body.textContent!, /same-session process/);
    assert.match(document.body.textContent!, /does not read or edit/);
    assert.equal(armed(), null);
    await act(async () => shortcutCheckbox().click());
    assert.ok(armed());
    assert.deepEqual(attached, []);
    await act(async () => shortcutCheckbox().click());
    assert.equal(armed(), null);
  }, "linux");
});

test("a late explicit Attach retires its staging lease after cancel, disable or composer replacement", async () => {
  for (const action of ["cancel", "disable", "replace"]) {
    await fixture(async ({ api, click, attached, abandoned, render }) => {
      await click("App Shot");
      await click("Example");
      const pending = deferred<ZenXImageDraft>();
      api.attach = async () => pending.promise;
      await click("Attach to draft");
      if (action === "cancel") await click("Close App Shot");
      else
        await render(
          action === "disable",
          action === "replace" ? "two" : "one",
        );
      await act(async () => pending.resolve(shot));
      assert.deepEqual(attached, []);
      assert.deepEqual(abandoned, [shot.id]);
    });
  }
});

test("GNOME setup is disclosed without installing or enabling the extension or shortcut", async () => {
  await fixture(async ({ api, click, armRequests }) => {
    let ready = false;
    api.configuration = async () => ({
      nativeForeground: ready,
      portalShortcut: true,
      gnomeSupport: ready ? "ready" : "extension-unavailable",
    });
    await click("App Shot");
    const disclosure = document.querySelector<HTMLDetailsElement>(
      ".app-shot-shortcut details",
    );
    assert.match(
      disclosure?.textContent ?? "",
      /GNOME capture extension needs setup/,
    );
    assert.match(
      disclosure?.textContent ?? "",
      /does not authenticate an executable/,
    );
    assert.match(disclosure?.textContent ?? "", /disable ZenX App Shots/);
    assert.equal(disclosure?.open, false);
    assert.equal(armRequests.length, 0);
    ready = true;
    await click("Refresh windows");
    assert.match(
      document.querySelector(".app-shot-shortcut details")?.textContent ?? "",
      /GNOME capture extension is available/,
    );
    assert.equal(armRequests.length, 0);
  }, "linux");
});

test("Wayland consent denial is not armed; configure is explicit and reports the desktop chord", async () => {
  await fixture(async ({ api, click, armed, emit, disarmed }) => {
    let configurations = 0;
    api.configuration = async () => ({
      nativeForeground: false,
      portalShortcut: true,
    });
    api.arm = async (token) => {
      return { registered: false, canConfigure: true };
    };
    api.configureShortcut = async () => {
      configurations++;
      return {
        registered: true,
        shortcutDescription: "Super+F8",
        canConfigure: true,
      };
    };
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutCheckbox().checked, false);
    assert.match(document.body.textContent ?? "", /not armed/);
    assert.equal(configurations, 0);
    await click("Configure desktop shortcut");
    assert.equal(configurations, 1);
    assert.equal(shortcutCheckbox().checked, true);
    assert.match(document.body.textContent ?? "", /Super\+F8/);
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutCheckbox().checked, false);
    assert.equal(disarmed.length, 1);
  }, "linux");
});

test("unassigned Wayland setup can be stopped without granting or capturing", async () => {
  await fixture(async ({ api, click, attached, disarmed }) => {
    api.configuration = async () => ({
      nativeForeground: false,
      portalShortcut: true,
    });
    api.arm = async () => ({ registered: false, canConfigure: true });
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    await click("Stop shortcut setup");
    assert.equal(disarmed.length, 1);
    assert.deepEqual(attached, []);
    assert.equal(
      document.body.textContent?.includes("Configure desktop shortcut"),
      false,
    );
  }, "linux");
});

test("queued Wayland status cannot revive a revoked or replaced registration", async () => {
  await fixture(async ({ api, click, armed, emit }) => {
    const originalArm = api.arm;
    api.configuration = async () => ({
      nativeForeground: true,
      portalShortcut: true,
    });
    api.arm = async (...args) => {
      await originalArm(...args);
      return {
        registered: true,
        shortcutDescription: "Super+F8",
        canConfigure: true,
      };
    };
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    const oldToken = armed()!;
    await act(async () => shortcutCheckbox().click());
    await act(async () =>
      emit({
        token: oldToken,
        shortcutState: {
          registered: true,
          shortcutDescription: "STALE",
          canConfigure: true,
        },
      }),
    );
    assert.equal(shortcutCheckbox().checked, false);
    assert.equal(document.body.textContent?.includes("STALE"), false);
    await act(async () => shortcutCheckbox().click());
    assert.notEqual(armed(), oldToken);
    await act(async () =>
      emit({
        token: oldToken,
        shortcutState: {
          registered: false,
          shortcutDescription: "STALE",
          canConfigure: true,
        },
      }),
    );
    assert.equal(shortcutCheckbox().checked, true);
    assert.equal(document.body.textContent?.includes("STALE"), false);
  }, "linux");
});

test("a portal-assigned different chord preserves the local Ctrl+Shift+2 picker", async () => {
  await fixture(async ({ api, click }) => {
    api.configuration = async () => ({
      nativeForeground: true,
      portalShortcut: true,
    });
    api.arm = async () => ({
      registered: true,
      shortcutDescription: "Super+F8",
      canConfigure: true,
    });
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    await click("Close App Shot");
    document
      .querySelector<HTMLButtonElement>('[aria-label="App Shot"]')!
      .focus();
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          code: "Digit2",
          key: "2",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.ok(document.querySelector('[role="dialog"]'));
  }, "linux");
});

test("another mounted Composer cannot discard the active owner's captured image", async () => {
  await fixture(async ({ render, click, armed, emit, discarded, attached }) => {
    await render(false, "one", true);
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    const firstToken = armed()!;
    await act(async () => emit({ token: firstToken, image: shot }));
    assert.equal(discarded.length, 0);
    await click("Attach to draft");
    assert.deepEqual(attached, [shot]);
    await click("App Shot");
    await act(async () => shortcutCheckbox().click());
    await act(async () =>
      emit({ token: firstToken, image: { ...shot, id: "retired" } }),
    );
    assert.ok(discarded.includes("retired"));
  });
});

test("KDE and Hyprland setup is collapsed, manual and distinct from capability errors", async () => {
  for (const backend of ["kde", "hyprland"] as const) {
    await fixture(async ({ api, click, armRequests }) => {
      let state = "setup";
      api.configuration = async () => ({
        nativeForeground: state === "ready",
        portalShortcut: true,
        ...(backend === "kde"
          ? {
              kdeSupport:
                state === "ready"
                  ? ("ready" as const)
                  : state === "error"
                    ? ("error" as const)
                    : ("manual-setup-required" as const),
            }
          : {
              hyprlandSupport:
                state === "ready"
                  ? ("ready" as const)
                  : state === "error"
                    ? ("error" as const)
                    : ("not-installed" as const),
            }),
        ...(state === "error"
          ? { nativeCaptureError: "Permission probe failed" }
          : {}),
      });
      await click("App Shot");
      const disclosure = document.querySelector<HTMLDetailsElement>(
        ".app-shot-shortcut details",
      )!;
      assert.equal(disclosure.open, false);
      assert.match(disclosure.textContent!, /manual setup/);
      assert.match(disclosure.textContent!, /resources\/app-shot-linux\//);
      assert.match(disclosure.textContent!, /user-owned/);
      assert.match(disclosure.textContent!, /does not install/);
      assert.match(disclosure.textContent!, /To revoke/);
      assert.equal(armRequests.length, 0);
      state = "error";
      await click("Refresh windows");
      assert.match(
        document.querySelector(".app-shot-shortcut summary")!.textContent!,
        /check failed/,
      );
      assert.match(
        document.querySelector('[role="alert"]')!.textContent!,
        /Permission probe failed/,
      );
      state = "ready";
      await click("Refresh windows");
      assert.match(
        document.querySelector(".app-shot-shortcut summary")!.textContent!,
        /is available/,
      );
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.equal(armRequests.length, 0);
    }, "linux");
  }
});

test("a stale native readiness probe cannot overwrite a refreshed or reopened picker", async () => {
  await fixture(async ({ api, click }) => {
    const pending =
      deferred<Awaited<ReturnType<NonNullable<AppShotApi["configuration"]>>>>();
    api.configuration = async () => pending.promise;
    await click("App Shot");
    await click("Close App Shot");
    api.configuration = async () => ({
      nativeForeground: true,
      kdeSupport: "ready",
    });
    await click("App Shot");
    await act(async () =>
      pending.resolve({
        nativeForeground: false,
        kdeSupport: "error",
        nativeCaptureError: "STALE",
      }),
    );
    assert.match(
      document.querySelector(".app-shot-shortcut summary")!.textContent!,
      /is available/,
    );
    assert.equal(document.body.textContent!.includes("STALE"), false);
  }, "linux");
});

test("Hyprland action-only state enables capture review without claiming keys or configuring the desktop", async () => {
  await fixture(async ({ api, click, armed, emit, attached, disarmed }) => {
    const originalArm = api.arm;
    api.configuration = async () => ({
      nativeForeground: true,
      portalShortcut: true,
      hyprlandSupport: "ready",
      hyprlandBinding: {
        legacy:
          "bind = CTRL SHIFT, 2, global, io.github.albert_zen.ZenX.Development:capture-window",
        lua: 'hl.bind("CTRL + SHIFT + 2", hl.dsp.global("io.github.albert_zen.ZenX.Development:capture-window"))',
      },
    });
    api.arm = async (...args) => {
      await originalArm(...args);
      return { registered: false, actionRegistered: true, canConfigure: false };
    };
    await click("App Shot");
    assert.match(document.body.textContent!, /xdg-desktop-portal-hyprland/);
    assert.match(document.body.textContent!, /bind = CTRL SHIFT, 2, global/);
    assert.match(document.body.textContent!, /hl\.bind/);
    assert.match(document.body.textContent!, /remove the binding/);
    await act(async () => shortcutCheckbox().click());
    const oldToken = armed()!;
    assert.equal(shortcutCheckbox().checked, true);
    assert.match(document.body.textContent!, /action is registered/);
    assert.match(
      document.body.textContent!,
      /does not confirm a physical shortcut/,
    );
    assert.equal(
      document.body.textContent!.includes("Desktop shortcut:"),
      false,
    );
    assert.equal(
      document.body.textContent!.includes("Configure desktop shortcut"),
      false,
    );
    await act(async () =>
      emit({
        token: oldToken,
        shortcutState: {
          registered: false,
          actionRegistered: false,
          canConfigure: false,
        },
      }),
    );
    assert.equal(shortcutCheckbox().checked, false);
    assert.match(document.body.textContent!, /action is not registered/);
    await act(async () =>
      emit({
        token: oldToken,
        shortcutState: {
          registered: false,
          actionRegistered: true,
          canConfigure: false,
        },
      }),
    );
    assert.equal(shortcutCheckbox().checked, true);
    const pendingConfiguration =
      deferred<Awaited<ReturnType<NonNullable<AppShotApi["configuration"]>>>>();
    api.configuration = async () => pendingConfiguration.promise;
    await click("Close App Shot");
    await act(async () => emit({ token: oldToken, image: shot }));
    assert.match(document.body.textContent!, /action is registered/);
    assert.equal(document.body.textContent!.includes("not armed"), false);
    assert.equal(
      document.body.textContent!.includes("Configure desktop shortcut"),
      false,
    );
    assert.deepEqual(attached, []);
    await click("Attach to draft");
    assert.deepEqual(attached, [shot]);
    document
      .querySelector<HTMLButtonElement>('[aria-label="App Shot"]')!
      .focus();
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          code: "Digit2",
          key: "2",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.ok(
      document.querySelector('[role="dialog"]'),
      "The local picker shortcut works while native readiness is still pending",
    );
    await act(async () => shortcutCheckbox().click());
    assert.equal(disarmed.length, 1);
    await act(async () =>
      emit({
        token: oldToken,
        shortcutState: {
          registered: false,
          actionRegistered: true,
          canConfigure: false,
        },
      }),
    );
    assert.equal(shortcutCheckbox().checked, false);
    assert.equal(
      document.body.textContent!.includes("action is registered"),
      false,
    );
  }, "linux");
});

const shortcutPreferenceKey = "zenx.appShot.shortcutKind";
function shortcutRadio(kind: AppShotShortcutKind): HTMLInputElement {
  const radio = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${kind}"]`,
  );
  assert.ok(radio, `Missing shortcut choice ${kind}`);
  return radio;
}
function applicationTextCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  assert.ok(checkbox, "Missing application text choice");
  return checkbox;
}

test("only the explicit shortcut kind survives Composer replacement and a fresh renderer", async () => {
  for (const platform of ["darwin", "win32"]) {
    let saved: string | null = null;
    await fixture(
      async ({ click, render, armed, armRequests, attached, calls }) => {
        assert.deepEqual(calls, []);
        await click("App Shot");
        await act(async () => shortcutRadio("chord").click());
        saved = window.localStorage.getItem(shortcutPreferenceKey);
        assert.equal(saved, "chord");
        await act(async () => applicationTextCheckbox().click());
        await act(async () => shortcutCheckbox().click());
        assert.equal(armRequests[0]?.includeAccessibility, true);
        assert.ok(armed());
        assert.deepEqual(Object.keys(window.localStorage), [
          shortcutPreferenceKey,
        ]);
        const before = [...calls];
        await render(false, "replacement");
        assert.equal(armed(), null);
        assert.equal(armRequests.length, 1);
        assert.deepEqual(calls, before);
        await click("App Shot");
        assert.equal(shortcutRadio("chord").checked, true);
        assert.equal(shortcutCheckbox().checked, false);
        assert.equal(applicationTextCheckbox().checked, false);
        assert.deepEqual(attached, []);
        assert.deepEqual(calls, ["list", "list"]);
      },
      platform,
    );
    await fixture(
      async ({ click, armed, armRequests, attached, calls }) => {
        assert.deepEqual(calls, []);
        assert.equal(armed(), null);
        assert.equal(armRequests.length, 0);
        await click("App Shot");
        assert.equal(shortcutRadio("chord").checked, true);
        assert.equal(shortcutCheckbox().checked, false);
        assert.equal(applicationTextCheckbox().checked, false);
        assert.deepEqual(attached, []);
        assert.deepEqual(calls, ["list"]);
      },
      platform,
      (dom) => dom.window.localStorage.setItem(shortcutPreferenceKey, saved!),
    );
  }
});

test("fresh Composers whitelist saved shortcut kinds and use platform defaults without writes", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const saved of [
      null,
      "both-shift",
      "both-control",
      "both-alt",
      "both-meta",
      "chord",
      "",
      "Ctrl+K",
      "CHORD",
      '{"kind":"chord","enabled":true}',
    ]) {
      await fixture(
        async ({ click, armed, armRequests, attached, calls }) => {
          assert.deepEqual(calls, []);
          await click("App Shot");
          const expected =
            platform === "linux"
              ? "chord"
              : isAppShotShortcutKind(saved)
                ? saved
                : "both-shift";
          assert.equal(shortcutRadio(expected).checked, true);
          if (platform === "linux")
            assert.ok(
              !document.querySelector('input[value^="both-"]'),
              "Linux must not offer physical modifier pairs",
            );
          assert.equal(shortcutCheckbox().checked, false);
          assert.equal(applicationTextCheckbox().checked, false);
          assert.equal(armed(), null);
          assert.equal(armRequests.length, 0);
          assert.deepEqual(attached, []);
          assert.deepEqual(calls, ["list"]);
          assert.equal(
            window.localStorage.getItem(shortcutPreferenceKey),
            saved,
          );
          if (platform === "linux" && saved?.startsWith("both-")) {
            await act(async () => shortcutCheckbox().click());
            assert.equal(armRequests[0]?.kind, "chord");
            assert.equal(armRequests[0]?.includeAccessibility, false);
          }
        },
        platform,
        (dom) => {
          if (saved !== null)
            dom.window.localStorage.setItem(shortcutPreferenceKey, saved);
        },
      );
    }
  }
});

test("blocked, missing or throwing storage keeps a live choice and visibly reports unsaved changes", async () => {
  for (const failure of ["getter", "missing", "read", "write"]) {
    await fixture(
      async ({ click, armRequests, attached, calls }) => {
        await click("App Shot");
        assert.equal(shortcutRadio("both-shift").checked, true);
        await act(async () => shortcutRadio("chord").click());
        assert.equal(shortcutRadio("chord").checked, true);
        assert.match(
          document.querySelector('[role="alert"]')?.textContent ?? "",
          /could not be saved/,
        );
        assert.equal(armRequests.length, 0);
        await click("Close App Shot");
        await click("App Shot");
        assert.equal(shortcutRadio("chord").checked, true);
        assert.match(
          document.querySelector('[role="alert"]')?.textContent ?? "",
          /could not be saved/,
        );
        await act(async () => shortcutCheckbox().click());
        assert.equal(armRequests[0]?.kind, "chord");
        assert.equal(armRequests[0]?.includeAccessibility, false);
        assert.match(
          document.querySelector('[role="alert"]')?.textContent ?? "",
          /could not be saved/,
        );
        await act(async () => i18n.changeLanguage("zh-CN"));
        assert.match(
          document.querySelector('[role="alert"]')?.textContent ?? "",
          /未能保存/,
        );
        await act(async () => i18n.changeLanguage("en"));
        assert.deepEqual(attached, []);
        assert.deepEqual(calls, ["list", "list"]);
      },
      "darwin",
      (dom) => {
        const storage = dom.window.localStorage;
        if (failure === "getter" || failure === "missing") {
          Object.defineProperty(dom.window, "localStorage", {
            get: () => {
              if (failure === "getter") throw new Error("Storage unavailable");
              return undefined;
            },
          });
        } else {
          const prototype = Object.getPrototypeOf(storage) as Storage;
          if (failure === "read")
            prototype.getItem = () => {
              throw new Error("Storage blocked");
            };
          prototype.setItem = () => {
            throw new Error("Storage full");
          };
        }
      },
    );
  }
});

test("a failed save preserves the previous persisted choice until another explicit change succeeds", async () => {
  await fixture(
    async ({ click, render, armed, armRequests, calls }) => {
      await click("App Shot");
      const prototype = Object.getPrototypeOf(window.localStorage) as Storage;
      const setItem = prototype.setItem;
      prototype.setItem = () => {
        throw new Error("Storage full");
      };
      await act(async () => shortcutRadio("chord").click());
      assert.equal(shortcutRadio("chord").checked, true);
      assert.equal(
        window.localStorage.getItem(shortcutPreferenceKey),
        "both-shift",
      );
      assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /could not be saved/,
      );
      prototype.setItem = setItem;
      await act(async () => shortcutRadio("both-shift").click());
      assert.ok(
        !document.querySelector('[role="alert"]'),
        "Successful explicit save clears the failure",
      );
      await act(async () => shortcutRadio("chord").click());
      assert.equal(window.localStorage.getItem(shortcutPreferenceKey), "chord");
      await render(false, "saved");
      await click("App Shot");
      assert.equal(shortcutRadio("chord").checked, true);
      assert.equal(shortcutCheckbox().checked, false);
      assert.equal(armed(), null);
      assert.equal(armRequests.length, 0);
      assert.deepEqual(calls, ["list", "list"]);
    },
    "darwin",
    (dom) =>
      dom.window.localStorage.setItem(shortcutPreferenceKey, "both-shift"),
  );
});

test("another Composer and storage events cannot alter an existing shortcut session", async () => {
  await fixture(
    async ({ click, render, armed, armRequests, calls, attached }) => {
      await render(false, "one", true);
      await click("App Shot");
      await act(async () => shortcutCheckbox().click());
      const token = armed();
      assert.equal(armRequests[0]?.kind, "both-shift");
      await click("Close App Shot");
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="App Shot"]',
        ),
      ];
      await act(async () => buttons[1]!.click());
      await act(async () => shortcutRadio("chord").click());
      assert.equal(window.localStorage.getItem(shortcutPreferenceKey), "chord");
      assert.equal(shortcutCheckbox().checked, false);
      await act(async () =>
        window.dispatchEvent(
          new window.StorageEvent("storage", {
            key: shortcutPreferenceKey,
            newValue: "chord",
            storageArea: window.localStorage,
          }),
        ),
      );
      await click("Close App Shot");
      await click("App Shot");
      assert.equal(shortcutRadio("both-shift").checked, true);
      assert.equal(shortcutCheckbox().checked, true);
      assert.equal(armed(), token);
      assert.equal(armRequests.length, 1);
      await act(async () => shortcutRadio("chord").click());
      assert.equal(shortcutRadio("both-shift").checked, true);
      await act(async () => shortcutCheckbox().click());
      assert.equal(shortcutRadio("both-shift").checked, true);
      assert.equal(armed(), null);
      assert.equal(armRequests.length, 1);
      assert.deepEqual(attached, []);
      assert.deepEqual(calls, ["list", "list", "list"]);
    },
  );
});

test("all physical pair choices use platform labels, warn about Windows menus and save only on change", async () => {
  for (const platform of ["darwin", "win32"]) {
    for (const [kind, macLabel, windowsLabel] of [
      ["both-shift", "Both Shift keys", "Both Shift keys"],
      ["both-control", "Both Control keys", "Both Control keys"],
      ["both-alt", "Both Option keys", "Both Alt keys"],
      ["both-meta", "Both Command keys", "Both Windows keys"],
    ] as const) {
      await fixture(
        async ({ click, render, armed, armRequests, calls, attached }) => {
          await click("App Shot");
          assert.equal(
            document.querySelectorAll('input[type="radio"]').length,
            5,
          );
          assert.equal(
            shortcutRadio(kind).closest("label")?.textContent,
            platform === "darwin" ? macLabel : windowsLabel,
          );
          // Explicitly visit another choice first, including when the desired pair is the default.
          await act(async () => shortcutRadio("chord").click());
          await act(async () => shortcutRadio(kind).click());
          assert.equal(
            window.localStorage.getItem(shortcutPreferenceKey),
            kind,
          );
          assert.equal(armRequests.length, 0);
          assert.match(document.body.textContent!, /already held/);
          if (platform === "win32" && kind === "both-meta")
            assert.match(
              document.body.textContent!,
              /may also open the system menu/,
            );
          else if (platform === "win32" && kind === "both-alt")
            assert.match(
              document.body.textContent!,
              /may also activate app menu bars/,
            );
          else
            assert.doesNotMatch(
              document.body.textContent!,
              /may also (?:open the system menu|activate app menu bars)/,
            );
          await act(async () => shortcutCheckbox().click());
          assert.equal(armRequests[0]?.kind, kind);
          assert.equal(shortcutRadio(kind).closest("fieldset")?.disabled, true);
          await act(async () => shortcutRadio("chord").click());
          assert.equal(shortcutRadio(kind).checked, true);
          await act(async () =>
            window.dispatchEvent(
              new window.StorageEvent("storage", {
                key: shortcutPreferenceKey,
                newValue: "chord",
              }),
            ),
          );
          assert.equal(shortcutRadio(kind).checked, true);
          assert.equal(armRequests.length, 1);
          await render(false, "replacement");
          await click("App Shot");
          assert.equal(shortcutRadio(kind).checked, true);
          assert.equal(shortcutCheckbox().checked, false);
          assert.equal(applicationTextCheckbox().checked, false);
          assert.equal(armed(), null);
          assert.equal(armRequests.length, 1);
          assert.deepEqual(Object.keys(window.localStorage), [
            shortcutPreferenceKey,
          ]);
          assert.deepEqual(attached, []);
          assert.deepEqual(calls, ["list", "list"]);
        },
        platform,
      );
    }
  }
});

test("physical pair choices cannot change during pending capture or shortcut startup", async () => {
  await fixture(async ({ api, click, armRequests }) => {
    await click("App Shot");
    const ready = deferred<string>();
    api.arm = async () => ready.promise;
    await act(async () => shortcutRadio("both-control").click());
    await act(async () => shortcutCheckbox().click());
    assert.equal(shortcutRadio("both-alt").closest("fieldset")?.disabled, true);
    await act(async () => shortcutRadio("both-alt").click());
    assert.equal(shortcutRadio("both-control").checked, true);
    await act(async () => shortcutCheckbox().click());
    await act(async () => ready.resolve("Left Control + Right Control"));
    const captured = deferred<ZenXImageDraft>();
    api.capture = async () => captured.promise;
    await click("Example");
    assert.equal(
      shortcutRadio("both-meta").closest("fieldset")?.disabled,
      true,
    );
    await act(async () => shortcutRadio("both-meta").click());
    assert.equal(shortcutRadio("both-control").checked, true);
    assert.equal(
      window.localStorage.getItem(shortcutPreferenceKey),
      "both-control",
    );
    assert.equal(armRequests.length, 0);
    await act(async () => captured.resolve(shot));
  });
});

function recordButton(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(
    "[data-keybinding-capture]",
  );
  assert.ok(element, "Missing custom chord recorder");
  return element;
}
async function pressRecorder(init: KeyboardEventInit) {
  const event = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => recordButton().dispatchEvent(event));
  return event;
}
async function startRecording(click: (label: string) => Promise<void>) {
  await act(async () => recordButton().focus());
  await click("Record a custom shortcut");
  assert.equal(recordButton().getAttribute("aria-pressed"), "true");
}

test("actual recorder cancels Escape, ignores Tab/repeat, releases on blur and remount, and never auto-arms", async () => {
  await fixture(async ({ click, render, armRequests, calls, attached }) => {
    await click("App Shot");
    await startRecording(click);
    await pressRecorder({ key: "Escape", code: "Escape" });
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    assert.ok(
      Boolean(document.querySelector('[role="dialog"]')),
      "Escape cancels recording, not the dialog",
    );
    await startRecording(click);
    await pressRecorder({ key: "Tab", code: "Tab" });
    // The Dialog moves focus on Tab; blur ends recording without saving Tab.
    assert.equal(window.localStorage.getItem(shortcutPreferenceKey), null);
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    await startRecording(click);
    await pressRecorder({
      key: "K",
      code: "KeyK",
      metaKey: true,
      altKey: true,
      repeat: true,
    });
    assert.equal(recordButton().getAttribute("aria-pressed"), "true");
    assert.equal(window.localStorage.getItem(shortcutPreferenceKey), null);
    await act(async () => shortcutRadio("chord").focus());
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    await startRecording(click);
    await render(false, "remount");
    await click("App Shot");
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    await startRecording(click); // The old instance released its admission.
    await pressRecorder({
      key: "@",
      code: "Digit2",
      metaKey: true,
      shiftKey: true,
    });
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    assert.equal(shortcutRadio("chord").checked, true);
    assert.equal(window.localStorage.getItem(shortcutPreferenceKey), "chord");
    assert.deepEqual(armRequests, []);
    assert.deepEqual(attached, []);
    assert.deepEqual(calls, ["list", "list"]);
  });
});

test("custom selection survives remount without authority and blocked storage retains only the live choice", async () => {
  await fixture(async ({ click, render, armRequests }) => {
    await click("App Shot");
    await startRecording(click);
    await pressRecorder({
      key: "k",
      code: "KeyK",
      metaKey: true,
      altKey: true,
    });
    assert.equal(
      document.querySelector("[data-app-shot-chord]")?.textContent,
      "Selected: Command+Alt+K",
    );
    assert.equal(
      shortcutRadio("chord").checked,
      false,
      "Custom selection is not mislabeled as the default",
    );
    assert.equal(
      window.localStorage.getItem(shortcutPreferenceKey),
      '{"kind":"chord","chord":"mod+alt+k"}',
    );
    await render(false, "fresh");
    await click("App Shot");
    assert.equal(
      document.querySelector("[data-app-shot-chord]")?.textContent,
      "Selected: Command+Alt+K",
    );
    assert.equal(shortcutCheckbox().checked, false);
    assert.equal(applicationTextCheckbox().checked, false);
    const prototype = Object.getPrototypeOf(window.localStorage) as Storage;
    const original = prototype.setItem;
    prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      await startRecording(click);
      await pressRecorder({
        key: " ",
        code: "Space",
        metaKey: true,
        shiftKey: true,
      });
      assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /could not be saved/,
      );
      assert.equal(
        document.querySelector("[data-app-shot-chord]")?.textContent,
        "Selected: Command+Shift+Space",
      );
      assert.equal(
        window.localStorage.getItem(shortcutPreferenceKey),
        '{"kind":"chord","chord":"mod+alt+k"}',
      );
      assert.equal(armRequests.length, 0);
    } finally {
      prototype.setItem = original;
    }
    await act(async () => shortcutCheckbox().click());
    assert.equal(
      appShotKeyChordAccelerator(armRequests[0]!.chord!),
      "CommandOrControl+Shift+Space",
    );
    assert.equal(recordButton().disabled, true);
  });
});

test("unsupported and editing conflicts remain visible and cannot save or arm", async () => {
  await fixture(async ({ click, armRequests }) => {
    await click("App Shot");
    await startRecording(click);
    for (const key of [
      { key: "c", code: "KeyC", metaKey: true },
      { key: "k", code: "KeyK", shiftKey: true },
      { key: "MediaPlayPause", code: "MediaPlayPause", metaKey: true },
    ]) {
      await pressRecorder(key);
      assert.ok(
        Boolean(document.querySelector('[role="alert"]')),
        "Invalid recording needs visible feedback",
      );
      assert.equal(recordButton().getAttribute("aria-pressed"), "true");
      assert.equal(window.localStorage.getItem(shortcutPreferenceKey), null);
      assert.deepEqual(armRequests, []);
    }
    await pressRecorder({ key: "Escape" });
  });
});

test("another armed Composer blocks Record visibly without capture or silent revocation", async () => {
  await fixture(
    async ({ click, render, armed, armRequests, disarmed, calls }) => {
      await render(false, "one", true);
      await click("App Shot");
      await act(async () => shortcutCheckbox().click());
      const owner = armed();
      await click("Close App Shot");
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="App Shot"]',
        ),
      ];
      await act(async () => buttons[1]!.click());
      await click("Record a custom shortcut");
      assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /Disable the active/,
      );
      assert.equal(recordButton().getAttribute("aria-pressed"), "false");
      assert.equal(armed(), owner);
      assert.equal(armRequests.length, 1);
      assert.deepEqual(disarmed, []);
      assert.deepEqual(calls, ["list", "list"]);
      assert.equal(window.localStorage.getItem(shortcutPreferenceKey), null);
    },
  );
});

test("local fixed picker remains available with a different custom chord but not a matching chord", async () => {
  for (const custom of [true, false])
    await fixture(async ({ click, calls }) => {
      await click("App Shot");
      if (custom) {
        await startRecording(click);
        await pressRecorder({
          key: "k",
          code: "KeyK",
          metaKey: true,
          altKey: true,
        });
      } else await act(async () => shortcutRadio("chord").click());
      await act(async () => shortcutCheckbox().click());
      await click("Close App Shot");
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="App Shot"]')!
          .focus(),
      );
      await act(async () =>
        document.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "@",
            code: "Digit2",
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      assert.equal(Boolean(document.querySelector('[role="dialog"]')), custom);
      assert.equal(
        calls.filter((call) => call === "list").length,
        custom ? 2 : 1,
      );
    });
});

test("Niri and Hyprland do not expose ordinary chord recording or apply a saved custom chord", async () => {
  for (const mode of ["niri", "hyprland"])
    await fixture(
      async ({ api, click, armRequests }) => {
        api.configuration = async () => ({
          nativeForeground: true,
          ...(mode === "niri"
            ? { niriBinding: "manual" }
            : {
                hyprlandBinding: { legacy: "manual", lua: "manual" },
                portalShortcut: true as const,
              }),
        });
        await click("App Shot");
        assert.equal(
          Boolean(document.querySelector("[data-keybinding-capture]")),
          false,
        );
        assert.equal(Boolean(document.querySelector("fieldset")), false);
        await act(async () => shortcutCheckbox().click());
        assert.equal(armRequests[0]?.kind, "chord");
        assert.equal(armRequests[0]?.chord, undefined);
        assert.equal(
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent === "Configure shortcut",
          ),
          false,
        );
      },
      "linux",
      (dom) =>
        dom.window.localStorage.setItem(
          shortcutPreferenceKey,
          '{"kind":"chord","chord":"mod+alt+k"}',
        ),
    );
});

test("blur or unmount during pending Record releases late admission without ending a newer recorder", async () => {
  for (const interrupt of ["blur", "unmount"])
    await fixture(async ({ api, click, render, armRequests }) => {
      const originalBegin = api.beginRecording;
      const originalEnd = api.endRecording;
      const delayed = deferred<void>();
      const begun: string[] = [];
      const ended: string[] = [];
      api.beginRecording = async (token) => {
        begun.push(token);
        await originalBegin(token);
        if (begun.length === 1) await delayed.promise;
      };
      api.endRecording = async (token) => {
        ended.push(token);
        await originalEnd(token);
      };
      await click("App Shot");
      await act(async () => recordButton().focus());
      await click("Record a custom shortcut");
      assert.equal(recordButton().getAttribute("aria-pressed"), "false");
      assert.equal(shortcutCheckbox().disabled, true);
      if (interrupt === "blur")
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>('[aria-label="Close App Shot"]')!
            .focus(),
        );
      else {
        await render(false, "replacement");
        await click("App Shot");
      }
      assert.ok(ended.includes(begun[0]!));
      await startRecording(click);
      assert.equal(begun.length, 2);
      await act(async () => delayed.resolve());
      assert.equal(recordButton().getAttribute("aria-pressed"), "true");
      assert.equal(ended.includes(begun[1]!), false);
      assert.deepEqual(armRequests, []);
      await pressRecorder({ key: "Escape" });
      assert.ok(ended.includes(begun[1]!));
    });
});

test("failed recording release stays visible, blocks enable and retries only on explicit release", async () => {
  await fixture(async ({ api, click, armRequests }) => {
    const originalEnd = api.endRecording;
    let attempts = 0;
    api.endRecording = async (token) => {
      attempts++;
      if (attempts === 1) throw new Error("Recording release unavailable");
      await originalEnd(token);
    };
    await click("App Shot");
    await startRecording(click);
    await pressRecorder({ key: "Escape" });
    assert.match(
      document.body.textContent!,
      /Recording access was not released/,
    );
    assert.equal(shortcutCheckbox().disabled, true);
    assert.equal(recordButton().disabled, true);
    assert.equal(attempts, 1);
    await act(async () => shortcutCheckbox().click());
    assert.deepEqual(armRequests, []);
    assert.equal(attempts, 1);
    await click("Release recording");
    assert.equal(attempts, 2);
    assert.equal(recordButton().disabled, false);
    assert.equal(shortcutCheckbox().disabled, false);
    assert.deepEqual(armRequests, []);
  });
});

test("late recording admission does not automatically retry a failed release", async () => {
  await fixture(async ({ api, click, armRequests }) => {
    const originalBegin = api.beginRecording;
    const originalEnd = api.endRecording;
    const delayed = deferred<void>();
    let attempts = 0;
    api.beginRecording = async (token) => {
      await originalBegin(token);
      await delayed.promise;
    };
    api.endRecording = async (token) => {
      attempts++;
      if (attempts === 1) throw new Error("release unavailable");
      await originalEnd(token);
    };
    await click("App Shot");
    await act(async () => recordButton().focus());
    await click("Record a custom shortcut");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close App Shot"]')!
        .focus(),
    );
    assert.equal(attempts, 1);
    assert.match(
      document.body.textContent!,
      /Recording access was not released/,
    );
    await act(async () => delayed.resolve());
    assert.equal(attempts, 1);
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    assert.equal(shortcutCheckbox().disabled, true);
    assert.deepEqual(armRequests, []);
    await click("Release recording");
    assert.equal(attempts, 2);
    assert.equal(shortcutCheckbox().disabled, false);
  });
});

test("failed unmount release survives replacement and only explicit recovery releases that token", async () => {
  await fixture(async ({ api, click, render, armRequests }) => {
    const originalBegin = api.beginRecording;
    const originalEnd = api.endRecording;
    const started: string[] = [];
    const ended: string[] = [];
    api.beginRecording = async (token) => {
      started.push(token);
      await originalBegin(token);
    };
    api.endRecording = async (token) => {
      ended.push(token);
      if (ended.length === 1) throw new Error("unmount release unavailable");
      await originalEnd(token);
    };
    await click("App Shot");
    await startRecording(click);
    await render(false, "replacement");
    await click("App Shot");
    assert.equal(recordButton().getAttribute("aria-pressed"), "false");
    assert.match(
      document.body.textContent!,
      /Recording access was not released/,
    );
    assert.match(document.body.textContent!, /unmount release unavailable/);
    assert.equal(shortcutCheckbox().disabled, true);
    assert.equal(recordButton().disabled, true);
    assert.deepEqual(ended, [started[0]]);
    assert.equal(started.length, 1);
    assert.deepEqual(armRequests, []);
    await click("Release recording");
    assert.deepEqual(ended, [started[0], started[0]]);
    assert.equal(shortcutCheckbox().disabled, false);
    await startRecording(click);
    assert.equal(started.length, 2);
    assert.notEqual(started[0], started[1]);
    await render(false, "successful-cleanup");
    await click("App Shot");
    assert.equal(Boolean(document.querySelector('[role="alert"]')), false);
    assert.equal(shortcutCheckbox().disabled, false);
    assert.equal(ended.at(-1), started[1]);
    await startRecording(click);
    assert.equal(started.length, 3);
    await pressRecorder({ key: "Escape" });
  });
});

test("pending unmount release reports a late failure to the new Composer without retrying", async () => {
  await fixture(async ({ api, click, render }) => {
    const originalEnd = api.endRecording;
    const delayed = deferred<void>();
    let attempts = 0;
    api.endRecording = async (token) => {
      attempts++;
      if (attempts === 1) {
        await delayed.promise;
        throw new Error("late unmount failure");
      }
      await originalEnd(token);
    };
    await click("App Shot");
    await startRecording(click);
    await render(false, "new");
    await click("App Shot");
    assert.equal(shortcutCheckbox().disabled, true);
    await act(async () => delayed.resolve());
    assert.match(document.body.textContent!, /late unmount failure/);
    assert.equal(attempts, 1);
    await click("Release recording");
    assert.equal(attempts, 2);
    await startRecording(click);
    await pressRecorder({ key: "Escape" });
  });
});

test("a sibling can retry failed release without leaving the original Composer stuck on a released token", async () => {
  await fixture(async ({ api, click, render }) => {
    const originalEnd = api.endRecording;
    let attempts = 0;
    api.endRecording = async (token) => {
      attempts++;
      if (attempts === 1) throw new Error("release unavailable");
      await originalEnd(token);
    };
    await render(false, "one", true);
    await click("App Shot");
    await startRecording(click);
    await pressRecorder({ key: "Escape" });
    assert.equal(attempts, 1);
    // Closing remains an explicit cancellation; keep the dialog mounted but open
    // the sibling by its own external entry to exercise the shared cleanup receipt.
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="App Shot"]',
      ),
    ];
    await act(async () => buttons[1]!.click());
    const releases = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((button) => button.textContent === "Release recording");
    assert.equal(releases.length, 2);
    await act(async () => releases[1]!.click());
    assert.equal(attempts, 2);
    // Both components observed the same successful exact-token cleanup.
    const recorders = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-keybinding-capture]",
      ),
    ];
    assert.equal(
      recorders.every((button) => !button.disabled),
      true,
    );
    await act(async () => recorders[0]!.click());
    assert.equal(recorders[0]!.getAttribute("aria-pressed"), "true");
  });
});

test("window blur and page hiding stop recording and release pending admission", async () => {
  for (const signal of ["blur", "hidden"])
    for (const pendingBegin of [false, true])
      await fixture(async ({ api, click, armRequests }) => {
        const originalBegin = api.beginRecording;
        const originalEnd = api.endRecording;
        const delayed = deferred<void>();
        const ended: string[] = [];
        api.beginRecording = async (token) => {
          await originalBegin(token);
          if (pendingBegin) await delayed.promise;
        };
        api.endRecording = async (token) => {
          ended.push(token);
          await originalEnd(token);
        };
        await click("App Shot");
        await act(async () => recordButton().focus());
        await click("Record a custom shortcut");
        await act(async () => {
          if (signal === "blur") window.dispatchEvent(new window.Event("blur"));
          else {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              value: "hidden",
            });
            document.dispatchEvent(new window.Event("visibilitychange"));
          }
        });
        assert.equal(recordButton().getAttribute("aria-pressed"), "false");
        assert.ok(ended.length >= 1);
        if (pendingBegin) await act(async () => delayed.resolve());
        assert.equal(recordButton().getAttribute("aria-pressed"), "false");
        assert.deepEqual(armRequests, []);
        assert.equal(window.localStorage.getItem(shortcutPreferenceKey), null);
        await startRecording(click);
        await pressRecorder({ key: "Escape" });
      });
});

test("recovered unmounted admission cannot release or interrupt a newer sibling on late resolution", async () => {
  await fixture(async ({ api, click, render, armRequests }) => {
    const originalBegin = api.beginRecording;
    const originalEnd = api.endRecording;
    const delayed = deferred<void>();
    const started: string[] = [];
    const ended: string[] = [];
    api.beginRecording = async (token) => {
      started.push(token);
      await originalBegin(token);
      if (started.length === 1) await delayed.promise;
    };
    api.endRecording = async (token) => {
      ended.push(token);
      if (ended.length === 1) throw new Error("release unavailable");
      await originalEnd(token);
    };
    await click("App Shot");
    await act(async () => recordButton().focus());
    await click("Record a custom shortcut");
    await render(false, "sibling");
    await click("App Shot");
    assert.match(
      document.body.textContent!,
      /Recording access was not released/,
    );
    await click("Release recording");
    await startRecording(click);
    assert.equal(started.length, 2);
    assert.deepEqual(ended, [started[0], started[0]]);
    await act(async () => delayed.resolve());
    assert.deepEqual(
      ended,
      [started[0], started[0]],
      "Confirmed old cleanup must not be attempted again",
    );
    assert.equal(recordButton().getAttribute("aria-pressed"), "true");
    assert.deepEqual(armRequests, []);
    await pressRecorder({ key: "Escape" });
    assert.equal(ended.at(-1), started[1]);
  });
});

import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { AttachmentRef } from "../../../src/attachment.js";
import type { Thread } from "../src/protocol-client/index.js";
import type { AppShotApi, AppShotEvent } from "../src/app-shot.js";
import {
  addComposerImages,
  beginImmediateComposerSubmission,
  acceptComposerSubmission,
  failImmediateComposerSubmission,
  recoverPendingSend,
  reconcileCanonicalAdmission,
  dismissPendingSend,
  editComposer,
  emptyComposerState,
  removeComposerImage,
  type ComposerDraftImage,
} from "../src/renderer/src/composer-state.js";

import { withAppShotContext } from "../src/renderer/src/app-shot-draft.js";
import { i18n } from "../src/renderer/src/i18n.js";

const { act, createElement } = React;
Object.assign(globalThis, { React });
const { ThreadView } = await import("../src/renderer/src/ThreadView.js");

const ref: AttachmentRef = {
  type: "attachment",
  sha256: "a".repeat(64),
  mediaType: "image/png",
  byteLength: 4,
  width: 1,
  height: 1,
};

test("paste and drop preserve file order while image-only send remains available", async () => {
  await withDom(async (dom, root) => {
    const imported: string[][] = [];
    let pickerCalls = 0;
    const submissions: string[] = [];
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "first.png", attachment: ref },
    ]);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onImportImages: async (files: readonly File[]) => {
            imported.push(files.map((file) => file.name));
          },
          onInterrupt: async () => undefined,
          onPickImages: async () => {
            pickerCalls += 1;
          },
          onReadAttachment: async () => new Uint8Array([1, 2, 3, 4]),
          onRemoveImage: () => undefined,
          onRespondToApproval: async () => undefined,
          onSubmit: async (intent: string) => {
            submissions.push(intent);
          },
        }),
      ),
    );
    const textarea = required<HTMLTextAreaElement>("textarea");
    await act(async () =>
      required<HTMLButtonElement>('[aria-label="Add images"]').click(),
    );
    assert.equal(pickerCalls, 1);
    const files = [
      new dom.window.File(["a"], "a.png", { type: "image/png" }),
      new dom.window.File(["b"], "b.webp", { type: "image/webp" }),
    ];
    const paste = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(paste, "clipboardData", { value: { files } });
    await act(async () => textarea.dispatchEvent(paste));

    const drop = new dom.window.Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files, dropEffect: "none" },
    });
    await act(async () => required(".thread-view").dispatchEvent(drop));
    assert.deepEqual(imported, [
      ["a.png", "b.webp"],
      ["a.png", "b.webp"],
    ]);

    await act(async () =>
      required<HTMLButtonElement>('[aria-label="Send"]').click(),
    );
    assert.deepEqual(submissions, ["start"]);
  });
});

test("image preview closes with Escape and returns focus to its named trigger", async () => {
  await withDom(async (_dom, root) => {
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "focus.png", attachment: ref },
    ]);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1, 2, 3, 4]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      ),
    );
    await act(async () => Promise.resolve());
    const trigger = required<HTMLButtonElement>(
      '[aria-label="Preview focus.png"]',
    );
    assert.equal(trigger.disabled, false);
    await act(async () => trigger.click());
    assert.equal(
      required('[role="dialog"]').getAttribute("aria-modal"),
      "true",
    );
    assert.ok(required(".image-preview-layer").parentElement === document.body);
    assert.equal(
      required('[role="dialog"]').getAttribute("aria-label"),
      "focus.png",
    );
    assert.equal(document.querySelector(".image-preview header"), null);
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Close image preview",
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Tab",
        }),
      ),
    );
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Close image preview",
    );
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
  });
});

test("App Shot is an image-style draft with exact context visible only on click", async () => {
  await withDom(async (_dom, root) => {
    const context =
      "  App: Example\nWindow: Design notes\nScreenshot only\n" +
      "<script>do not execute</script>\n[link](https://example.invalid)\n" +
      "  Leading and trailing spaces stay intact  \n" +
      "Long captured line ".repeat(1500);
    const shot = appShotImage(context);
    const composer = addComposerImages(
      editComposer(emptyComposerState(), "Keep my draft"),
      [shot],
    );
    await act(async () => root.render(attachmentView({ composer })));
    const trigger = required<HTMLButtonElement>(
      '[aria-label="Preview App Shot · Example.png"]',
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector(".draft-image details"), null);
    assert.equal(document.querySelector(".draft-image pre"), null);
    assert.equal(required(".draft-app-shot-label").textContent, "App Shot");
    assert.equal(required(".draft-image").closest(".composer"), null);
    assert.equal(
      required<HTMLTextAreaElement>("textarea").value,
      "Keep my draft",
    );

    await act(async () => trigger.click());
    const dialog = required<HTMLElement>(".app-shot-attachment-preview");
    assert.equal(dialog.getAttribute("role"), "dialog");
    assert.equal(dialog.getAttribute("aria-label"), shot.name);
    assert.equal(dialog.querySelector("img")?.getAttribute("alt"), shot.name);
    const preview = required<HTMLElement>(".app-shot-attachment-context pre");
    assert.equal(preview.textContent, context);
    assert.equal(dialog.querySelector("script, a"), null);
    assert.equal(dialog.querySelectorAll("button").length, 1);
    assert.equal(
      dialog.querySelector("button")?.getAttribute("aria-label"),
      "Close image preview",
    );
    const sent = withAppShotContext("", composer.draft.images);
    const payload = JSON.parse(sent.slice(sent.indexOf("\n") + 1)) as Array<{
      context: string;
    }>;
    assert.equal(payload[0]?.context, preview.textContent);

    const close = required<HTMLButtonElement>(".image-preview-close");
    assert.equal(document.activeElement, close);
    await pressPreviewKey("Tab");
    assert.equal(document.activeElement, preview);
    await pressPreviewKey("Tab");
    assert.equal(document.activeElement, close);
    await pressPreviewKey("Tab", true);
    assert.equal(document.activeElement, preview);
    await pressPreviewKey("Escape");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(
      required<HTMLTextAreaElement>("textarea").value,
      "Keep my draft",
    );
  });
});

test("App Shot repeated opening, close and backdrop never attach or send", async () => {
  await withDom(async (dom, root) => {
    Object.assign(window, {
      zenx: {
        appShot: {
          capture: () => assert.fail("preview cannot capture"),
          attach: () => assert.fail("preview cannot attach"),
        },
      },
    });
    await act(async () =>
      root.render(
        attachmentView({
          composer: addComposerImages(emptyComposerState(), [appShotImage()]),
        }),
      ),
    );
    const trigger = required<HTMLButtonElement>(
      ".draft-image .image-thumbnail",
    );
    for (const dismiss of ["close", "backdrop", "escape"]) {
      await act(async () => trigger.click());
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
      assert.equal(
        required(".app-shot-attachment-context pre").textContent,
        appShotImage().appShotContext,
      );
      if (dismiss === "close") {
        await act(async () =>
          required<HTMLButtonElement>(".image-preview-close").click(),
        );
      } else if (dismiss === "backdrop") {
        await act(async () =>
          required(".image-preview-layer").dispatchEvent(
            new dom.window.Event("pointerdown", { bubbles: true }),
          ),
        );
      } else await pressPreviewKey("Escape");
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(document.activeElement, trigger);
    }
  });
});

test("removing an App Shot closes its preview and removes only its image and context", async () => {
  await withDom(async (_dom, root) => {
    let composer = addComposerImages(
      editComposer(emptyComposerState(), "Keep this text"),
      [
        appShotImage(),
        { id: "ordinary", name: "ordinary.png", attachment: ref },
      ],
    );
    const render = () =>
      root.render(
        attachmentView({
          composer,
          onRemoveImage: (id) => {
            composer = removeComposerImage(composer, id);
            render();
          },
        }),
      );
    await act(async () => render());
    await act(async () =>
      required<HTMLButtonElement>(
        '[aria-label="Preview App Shot · Example.png"]',
      ).click(),
    );
    await act(async () =>
      required<HTMLButtonElement>('[aria-label="Remove Example.png"]').click(),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector(".draft-app-shot-label"), null);
    assert.equal(composer.draft.text, "Keep this text");
    assert.deepEqual(
      composer.draft.images.map((image) => image.id),
      ["ordinary"],
    );
    assert.equal(
      withAppShotContext(composer.draft.text, composer.draft.images),
      "Keep this text",
    );
    assert.equal(document.activeElement, required("textarea"));
    const ordinary = required<HTMLButtonElement>(
      '[aria-label="Preview ordinary.png"]',
    );
    await act(async () => ordinary.click());
    assert.equal(required('[role="dialog"]').className, "image-preview-layer");
    assert.equal(document.querySelector(".app-shot-attachment-context"), null);
    await pressPreviewKey("Escape");
    assert.equal(document.activeElement, ordinary);
  });
});

test("closing App Shot details does not steal newer focus outside the viewer", async () => {
  await withDom(async (_dom, root) => {
    await act(async () =>
      root.render(
        attachmentView({
          composer: addComposerImages(emptyComposerState(), [appShotImage()]),
        }),
      ),
    );
    await act(async () =>
      required<HTMLButtonElement>(".draft-image .image-thumbnail").click(),
    );
    const textarea = required<HTMLTextAreaElement>("textarea");
    await act(async () => textarea.focus());
    await pressPreviewKey("Escape");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, textarea);
  });
});

test("App Shot preview retires on Composer, Thread, attachment or context replacement", async () => {
  for (const change of [
    "composer",
    "thread",
    "attachment",
    "context",
    "remove",
  ]) {
    await withDom(async (_dom, root) => {
      const shot = appShotImage();
      const original = {
        composerId: "composer-one",
        thread: emptyThread(),
        composer: addComposerImages(emptyComposerState(), [shot]),
      };
      await act(async () => root.render(attachmentView(original)));
      await act(async () =>
        required<HTMLButtonElement>(".draft-image .image-thumbnail").click(),
      );
      const next = {
        ...original,
        ...(change === "composer" ? { composerId: "composer-two" } : {}),
        ...(change === "thread"
          ? { thread: { ...emptyThread(), id: "thread-two" } }
          : {}),
        ...(change === "attachment" ||
        change === "context" ||
        change === "remove"
          ? {
              composer: addComposerImages(
                emptyComposerState(),
                change === "remove"
                  ? []
                  : [
                      {
                        ...shot,
                        ...(change === "context"
                          ? { appShotContext: "New context" }
                          : {}),
                        ...(change === "attachment"
                          ? { attachment: { ...ref, sha256: "c".repeat(64) } }
                          : {}),
                      },
                    ],
              ),
            }
          : {}),
      };
      await act(async () => root.render(attachmentView(next)));
      assert.equal(document.querySelector('[role="dialog"]'), null, change);
      if (change === "composer" || change === "thread") {
        assert.equal(
          document.activeElement,
          document.body,
          "no focus stolen into new owner",
        );
      }
      if (change === "context") {
        await act(async () =>
          required<HTMLButtonElement>(".draft-image .image-thumbnail").click(),
        );
        assert.equal(
          required(".app-shot-attachment-context pre").textContent,
          "New context",
        );
      }
    });
  }
});

test("each App Shot opens its own context, including an empty captured string", async () => {
  await withDom(async (_dom, root) => {
    await act(async () =>
      root.render(
        attachmentView({
          composer: addComposerImages(emptyComposerState(), [
            appShotImage("First context"),
            { ...appShotImage(""), id: "second-shot", name: "Second.png" },
          ]),
        }),
      ),
    );
    assert.equal(document.querySelectorAll(".draft-app-shot-label").length, 2);
    for (const [name, context] of [
      ["Example.png", "First context"],
      ["Second.png", ""],
    ]) {
      await act(async () =>
        required<HTMLButtonElement>(
          `[aria-label="Preview App Shot · ${name}"]`,
        ).click(),
      );
      assert.equal(
        required(".app-shot-attachment-context pre").textContent,
        context,
      );
      await pressPreviewKey("Escape");
    }
  });
});

test("App Shot context stays readable after image decode failure and respects localization", async () => {
  await withDom(async (dom, root) => {
    await i18n.changeLanguage("zh-CN");
    try {
      await act(async () =>
        root.render(
          attachmentView({
            composer: addComposerImages(emptyComposerState(), [appShotImage()]),
          }),
        ),
      );
      assert.equal(
        required(".draft-app-shot-label").textContent,
        i18n.t("shell:appShot"),
      );
      await act(async () =>
        required<HTMLButtonElement>(".draft-image .image-thumbnail").click(),
      );
      await act(async () =>
        required(".image-preview-content img").dispatchEvent(
          new dom.window.Event("error"),
        ),
      );
      assert.equal(
        required('[role="alert"]').textContent,
        i18n.t("panels:imageUnavailable"),
      );
      assert.equal(
        required(".app-shot-attachment-context h2").textContent,
        i18n.t("shell:appShotContext"),
      );
      assert.equal(
        required(".app-shot-attachment-context pre").textContent,
        appShotImage().appShotContext,
      );
      await pressPreviewKey("Escape");
      assert.equal(document.querySelector('[role="dialog"]'), null);
    } finally {
      await act(async () => i18n.changeLanguage("en"));
    }
  });
});

test("App Shot details open after thumbnail read or decode failure without retrying", async () => {
  for (const failure of ["read", "decode"]) {
    await withDom(async (dom, root) => {
      let reads = 0;
      const shot = {
        ...appShotImage(),
        attachment: {
          ...ref,
          sha256: (failure === "read" ? "d" : "e").repeat(64),
        },
      };
      await act(async () =>
        root.render(
          attachmentView({
            composer: addComposerImages(emptyComposerState(), [shot]),
            onReadAttachment: async () => {
              reads++;
              if (failure === "read")
                throw new Error("synthetic unavailable draft");
              return new Uint8Array([1]);
            },
          }),
        ),
      );
      if (failure === "decode") {
        await act(async () =>
          required(".draft-image img").dispatchEvent(
            new dom.window.Event("error"),
          ),
        );
      }
      const trigger = required<HTMLButtonElement>(
        ".draft-image .image-thumbnail",
      );
      assert.equal(
        trigger.disabled,
        false,
        "App Shot context is independently readable",
      );
      assert.equal(reads, 1);
      for (let attempt = 0; attempt < 2; attempt++) {
        await act(async () => trigger.click());
        const dialog = required('[role="dialog"]');
        assert.equal(
          dialog.querySelector(".app-shot-attachment-context pre")?.textContent,
          shot.appShotContext,
        );
        assert.equal(
          dialog.querySelector('[role="alert"]')?.textContent,
          i18n.t("panels:imageUnavailable"),
        );
        assert.equal(dialog.querySelector("img"), null);
        assert.equal(
          reads,
          1,
          "Inspecting context must not retry the failed payload",
        );
        await pressPreviewKey("Escape");
        assert.equal(document.activeElement, trigger);
      }
    });
  }
});

test("App Shot context opens while pixels load and ordinary failed images stay disabled", async () => {
  await withDom(async (_dom, root) => {
    let resolve!: (bytes: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((done) => {
      resolve = done;
    });
    let reads = 0;
    await act(async () =>
      root.render(
        attachmentView({
          composer: addComposerImages(emptyComposerState(), [
            {
              ...appShotImage(),
              attachment: { ...ref, sha256: "9".repeat(64) },
            },
          ]),
          onReadAttachment: async () => {
            reads++;
            return pending;
          },
        }),
      ),
    );
    const trigger = required<HTMLButtonElement>(
      ".draft-image .image-thumbnail",
    );
    assert.equal(trigger.disabled, false);
    await act(async () => trigger.click());
    assert.equal(
      required(".app-shot-attachment-context pre").textContent,
      appShotImage().appShotContext,
    );
    assert.ok(required('[role="dialog"] [role="status"]'));
    assert.ok(reads <= 2, "At most one read per mounted thumbnail/viewer");
    await act(async () => resolve(new Uint8Array([1])));
    assert.ok(required('[role="dialog"] img'));
    await pressPreviewKey("Escape");
    await act(async () =>
      root.render(
        attachmentView({
          composer: addComposerImages(emptyComposerState(), [
            {
              id: "ordinary-failed",
              name: "ordinary-failed.png",
              attachment: { ...ref, sha256: "8".repeat(64) },
            },
          ]),
          onReadAttachment: async () => {
            throw new Error("ordinary unavailable");
          },
        }),
      ),
    );
    assert.equal(
      required<HTMLButtonElement>(".draft-image .image-thumbnail").disabled,
      true,
    );
  });
});

test("direct App Shot attachment focuses Composer only when no modal remains open", async () => {
  await withDom(async (_dom, root) => {
    let token = "";
    let listener: ((event: AppShotEvent) => void) | undefined;
    let attached = 0;
    const api: AppShotApi = {
      configuration: async () => ({ nativeForeground: true }),
      list: async () => [],
      capture: async () => assert.fail("shortcut must not recapture"),
      read: async () => new Uint8Array([1]),
      attach: async () => appShotImage(),
      discard: async () => {},
      arm: async (nextToken) => {
        token = nextToken;
        return "Both Shift";
      },
      disarm: async () => {},
      beginRecording: async () => {},
      endRecording: async () => {},
      onCapture: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    };
    Object.assign(window, { zenx: { platform: "darwin", appShot: api } });
    await act(async () =>
      root.render(
        attachmentView({
          onAddAppShot: () => {
            attached++;
          },
        }),
      ),
    );
    await act(async () =>
      required<HTMLButtonElement>('[aria-label="App Shot"]').click(),
    );
    await act(async () =>
      required<HTMLInputElement>(
        '.app-shot-shortcut input[type="checkbox"]',
      ).click(),
    );
    assert.ok(token);
    const close = required<HTMLButtonElement>('[aria-label="Close App Shot"]');
    await act(async () => close.focus());
    await act(async () =>
      listener?.({ token, image: { ...appShotImage(), id: "first" } }),
    );
    assert.equal(attached, 1);
    assert.equal(
      document.activeElement,
      close,
      "An open picker retains its focus",
    );
    await act(async () => close.click());
    // Radix dismisses modal presence asynchronously; wait for its DOM removal.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () =>
      listener?.({ token, image: { ...appShotImage(), id: "second" } }),
    );
    assert.equal(attached, 2);
    assert.equal(document.activeElement, required("textarea"));
  });
});

function appShotImage(
  context = "App: Example\nWindow: Example\nScreenshot only",
): ComposerDraftImage {
  return {
    id: "app-shot-draft",
    name: "Example.png",
    attachment: { ...ref, sha256: "b".repeat(64) },
    appShotContext: context,
  };
}

function attachmentView(
  overrides: Partial<React.ComponentProps<typeof ThreadView>>,
) {
  return createElement(ThreadView, {
    approvals: [],
    composer: emptyComposerState(),
    thread: emptyThread(),
    onDraftChange: () => assert.fail("preview cannot edit text"),
    onInterrupt: async () => assert.fail("preview cannot interrupt"),
    onReadAttachment: async () => new Uint8Array([1, 2, 3, 4]),
    onRemoveImage: () => assert.fail("preview cannot remove images"),
    onRespondToApproval: async () => undefined,
    onSubmit: async () => assert.fail("preview cannot send"),
    ...overrides,
  });
}

async function pressPreviewKey(key: string, shiftKey = false) {
  await act(async () =>
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        shiftKey,
      }),
    ),
  );
}

test("unsupported image capability disables Send without removing the draft", async () => {
  await withDom(async (_dom, root) => {
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "blocked.png", attachment: ref },
    ]);
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          imageCapabilityError: "This model does not support image input.",
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => assert.fail("blocked before submission"),
        }),
      ),
    );
    assert.equal(
      required<HTMLButtonElement>('[aria-label="Send"]').disabled,
      true,
    );
    assert.match(
      document.body.textContent ?? "",
      /does not support image input/u,
    );
    assert.ok(required('[aria-label="Preview blocked.png"]'));
  });
});

test("Unknown image capability warns but keeps the try-send action available", async () => {
  await withDom(async (_dom, root) => {
    const composer = addComposerImages(emptyComposerState(), [
      { id: "draft-1", name: "unknown.png", attachment: ref },
    ]);
    let submitted = false;
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          imageCapabilityNotice:
            "Image input capability is unknown. You can try sending now.",
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => void (submitted = true),
        }),
      ),
    );
    const send = required<HTMLButtonElement>('[aria-label="Send"]');
    assert.equal(send.disabled, false);
    assert.match(document.body.textContent ?? "", /try sending now/u);
    await act(async () => send.click());
    assert.equal(submitted, true);
  });
});

test("the Composer overlay publishes its live bottom-zone height", async () => {
  await withDom(async (_dom, root) => {
    const observers = new Map<Element, Set<() => void>>();
    class FakeResizeObserver {
      private targets = new Set<Element>();
      constructor(private callback: ResizeObserverCallback) {}
      private deliver = () =>
        this.callback(
          [...this.targets].map((target) => ({
            target,
            contentRect: target.getBoundingClientRect(),
          })) as ResizeObserverEntry[],
          this as unknown as ResizeObserver,
        );
      observe(element: Element): void {
        this.targets.add(element);
        const callbacks = observers.get(element) ?? new Set<() => void>();
        callbacks.add(this.deliver);
        observers.set(element, callbacks);
      }
      unobserve(element: Element): void {
        this.targets.delete(element);
        const callbacks = observers.get(element);
        callbacks?.delete(this.deliver);
        if (callbacks?.size === 0) observers.delete(element);
      }
      disconnect(): void {
        for (const element of [...this.targets]) this.unobserve(element);
      }
    }
    Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });
    try {
      await act(async () =>
        root.render(
          createElement(ThreadView, {
            approvals: [],
            composer: editComposer(
              emptyComposerState(),
              "A real draft whose measured height changes with width",
            ),
            thread: emptyThread(),
            onDraftChange: () => undefined,
            onInterrupt: async () => undefined,
            onRespondToApproval: async () => undefined,
            onSubmit: async () => undefined,
          }),
        ),
      );
      const view = required<HTMLElement>(".thread-view");
      assert.equal(view.style.getPropertyValue("--bottom-zone-height"), "0px");
      required<HTMLElement>(".bottom-zone").getBoundingClientRect = () =>
        ({ height: 216 }) as DOMRect;
      const notify = observers.get(required<HTMLElement>(".bottom-zone"));
      assert.ok(notify);
      await act(async () => notify.forEach((callback) => callback()));
      assert.equal(
        view.style.getPropertyValue("--bottom-zone-height"),
        "216px",
      );
      const textarea = required<HTMLTextAreaElement>("textarea");
      let width = 160;
      let height = 100;
      textarea.getBoundingClientRect = () => ({ width }) as DOMRect;
      Object.defineProperty(textarea, "scrollHeight", { get: () => height });
      const resized = observers.get(textarea);
      assert.ok(resized);
      await act(async () => resized.forEach((callback) => callback()));
      assert.equal(textarea.style.height, "100px");
      width = 480;
      height = 36;
      await act(async () => resized.forEach((callback) => callback()));
      assert.equal(textarea.style.height, "36px");
    } finally {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });
});

test("pending multi-image send preserves warm previews, honest status and recoverable attachments", async () => {
  await withDom(async (_dom, root) => {
    const images = ["b", "c"].map((digit, index) => ({
      id: `pending-${digit}`,
      name: `synthetic-${index}.png`,
      attachment: { ...ref, sha256: `728${index}${digit}`.padEnd(64, "0") },
    }));
    let composer = addComposerImages(
      editComposer(emptyComposerState(), "Synthetic message"),
      images,
    );
    let reads = 0;
    let viewThread = emptyThread();
    const render = () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread: viewThread,
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => {
            reads++;
            return new Uint8Array([1, 2, 3, 4]);
          },
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      );
    await act(async () => render());
    const sources = [
      ...document.querySelectorAll<HTMLImageElement>(".draft-image img"),
    ].map((image) => image.src);
    assert.equal(reads, 2);
    composer = beginImmediateComposerSubmission(
      composer,
      "start",
      null,
      () => "pending-images",
    );
    await act(async () => render());
    const row = required(".pending-send-row");
    assert.deepEqual(
      [...row.querySelectorAll<HTMLImageElement>(".message-images img")].map(
        (image) => image.src,
      ),
      sources,
    );
    assert.equal(row.querySelector("ul"), null);
    assert.equal(
      row.querySelector(".user-bubble")?.textContent,
      "Synthetic message",
    );
    assert.equal(row.getAttribute("data-send-state"), "sending");
    assert.equal(reads, 2, "draft-to-pending must reuse warm payloads");
    assert.equal(
      beginImmediateComposerSubmission(
        composer,
        "start",
        null,
        () => "duplicate",
      ),
      composer,
    );
    await act(async () =>
      required<HTMLButtonElement>(".pending-send-row .image-thumbnail").click(),
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    composer = failImmediateComposerSubmission(
      composer,
      "pending-images",
      "Synthetic disconnected transport",
      true,
    );
    await act(async () => render());
    assert.equal(
      required(".pending-send-row").getAttribute("data-send-state"),
      "unconfirmed",
    );
    assert.equal(document.querySelectorAll(".pending-send-row img").length, 2);
    composer = recoverPendingSend(composer, "pending-images");
    composer = dismissPendingSend(composer, "pending-images");
    await act(async () => render());
    assert.equal(document.querySelector(".pending-send-row"), null);
    assert.equal(document.querySelectorAll(".draft-image img").length, 2);
    assert.equal(reads, 2, "dismissal must not revoke recovered previews");
    composer = beginImmediateComposerSubmission(
      composer,
      "start",
      null,
      () => "unused",
    );
    composer = acceptComposerSubmission(composer, "pending-images");
    await act(async () => render());
    assert.equal(
      required(".pending-send-row").getAttribute("data-send-state"),
      "admitted",
    );
    assert.equal(document.querySelectorAll(".pending-send-row img").length, 2);
    await act(async () =>
      required<HTMLButtonElement>(".pending-send-row .image-thumbnail").click(),
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    viewThread = { ...viewThread, id: "other-thread" };
    composer = emptyComposerState();
    await act(async () => render());
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "navigation retires the old pending preview",
    );
  });
});

test("pending preview retires on Composer replacement even with the same null Thread", async () => {
  for (const thread of [null, emptyThread()]) {
    await withDom(async (_dom, root) => {
      let composerId = "pending-owner-one";
      let composer = beginImmediateComposerSubmission(
        addComposerImages(emptyComposerState(), [
          { id: "pending-owned", name: "owned.png", attachment: ref },
        ]),
        "start",
        null,
        () => "pending-owned-client",
      );
      const render = () =>
        root.render(attachmentView({ composerId, composer, thread }));
      await act(async () => render());
      await act(async () =>
        required<HTMLButtonElement>(
          ".pending-send-row .image-thumbnail",
        ).click(),
      );
      assert.ok(document.querySelector('[role="dialog"]'));
      assert.equal(
        composer.draft.images.length,
        0,
        "pending viewer must not depend on cleared draft images",
      );
      composerId = "pending-owner-two";
      composer = emptyComposerState();
      await act(async () => render());
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(
        document.activeElement,
        document.body,
        "old preview must not focus the new Composer",
      );
    });
  }
});

test("image-only pending send becomes one canonical image row without an empty bubble or payload reload", async () => {
  await withDom(async (_dom, root) => {
    const attachment = { ...ref, sha256: "d".repeat(64) };
    let composer = addComposerImages(emptyComposerState(), [
      { id: "image-only", name: "only.png", attachment },
    ]);
    let thread = emptyThread();
    let reads = 0;
    const render = () =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer,
          thread,
          threadAttachments: { "image-message": [attachment] },
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => {
            reads++;
            return new Uint8Array([1, 2, 3, 4]);
          },
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      );
    await act(async () => render());
    const src = required<HTMLImageElement>(".draft-image img").src;
    composer = beginImmediateComposerSubmission(
      composer,
      "start",
      null,
      () => "image-client",
    );
    await act(async () => render());
    assert.equal(required<HTMLImageElement>(".pending-send-row img").src, src);
    assert.equal(
      document.querySelector(".pending-send-row .user-bubble"),
      null,
    );
    composer = failImmediateComposerSubmission(
      composer,
      "image-client",
      "Synthetic pre-dispatch failure",
      false,
    );
    await act(async () => render());
    assert.equal(
      required(".pending-send-row").getAttribute("data-send-state"),
      "notSent",
    );
    assert.equal(document.querySelectorAll(".draft-image img").length, 1);
    composer = beginImmediateComposerSubmission(
      composer,
      "start",
      null,
      () => "must-not-change-id",
    );
    await act(async () => render());
    await act(async () =>
      required<HTMLButtonElement>(".pending-send-row .image-thumbnail").click(),
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    composer = reconcileCanonicalAdmission(composer, [
      {
        type: "user_message",
        id: "image-message",
        clientId: "image-client",
        threadId: thread.id,
        turnId: "image-turn",
        createdAt: "2026-01-01T00:00:00Z",
        content: [{ type: "image", attachment }],
      },
    ]);
    thread = {
      ...thread,
      turns: [
        {
          id: "image-turn",
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
          items: [
            {
              type: "userMessage",
              id: "image-message",
              clientId: "image-client",
              content: [],
            },
          ],
        },
      ],
    };
    await act(async () => render());
    assert.equal(document.querySelector(".pending-send-row"), null);
    assert.equal(document.querySelectorAll(".user-row").length, 1);
    assert.equal(document.querySelector(".user-bubble"), null);
    assert.equal(
      required<HTMLImageElement>('[data-sent-message-id="image-message"] img')
        .src,
      src,
    );
    assert.equal(reads, 1);
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(
      document.activeElement === required("textarea"),
      "canonical handoff removes the trigger, so dismissal returns to the same Composer",
    );
  });
});

test("attachment thumbnails reuse cached payloads across streaming re-renders and remounts", async () => {
  await withDom(async (dom, root) => {
    const streaming: AttachmentRef = {
      type: "attachment",
      sha256: "f".repeat(64),
      mediaType: "image/png",
      byteLength: 4,
      width: 1,
      height: 1,
    };
    let reads = 0;
    let createdUrls = 0;
    Object.assign(dom.window.URL, {
      createObjectURL: () => `blob:zenx-stream-${String((createdUrls += 1))}`,
    });
    const streamingView = (attachment: AttachmentRef) =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: addComposerImages(emptyComposerState(), [
            { id: "draft-1", name: "stream.png", attachment },
          ]),
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => {
            reads += 1;
            return new Uint8Array([1, 2, 3, 4]);
          },
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      );
    await act(async () => void streamingView(streaming));
    await act(async () => Promise.resolve());
    const firstSrc = required<HTMLImageElement>(".draft-image img").src;
    assert.equal(reads, 1);
    assert.equal(createdUrls, 1);

    // A streaming re-render with fresh callback and attachment identities of
    // the same attachment must not re-read, recreate the object URL, or drop
    // back to the loading placeholder.
    await act(async () => void streamingView({ ...streaming }));
    await act(async () => Promise.resolve());
    assert.equal(reads, 1);
    assert.equal(createdUrls, 1);
    assert.equal(required<HTMLImageElement>(".draft-image img").src, firstSrc);

    // Unmount and remount (Turn disclosure collapse and reopen) also reuse
    // the session cache instead of flashing the loading placeholder.
    await act(async () => root.render(null));
    await act(async () => void streamingView(streaming));
    assert.equal(reads, 1);
    assert.equal(createdUrls, 1);
    assert.equal(required<HTMLImageElement>(".draft-image img").src, firstSrc);
  });
});

test("attachment object URLs are bounded and revoked without evicting the recent remount", async () => {
  await withDom(async (dom, root) => {
    const created: string[] = [];
    const revoked: string[] = [];
    Object.assign(dom.window.URL, {
      createObjectURL: () => {
        const url = `blob:zenx-cache-${String(created.length + 1)}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    const attachmentAt = (index: number): AttachmentRef => ({
      type: "attachment",
      sha256: index.toString(16).padStart(64, "0"),
      mediaType: "image/png",
      byteLength: 4,
      width: 1,
      height: 1,
    });
    const renderAttachment = (attachment: AttachmentRef) =>
      root.render(
        createElement(ThreadView, {
          approvals: [],
          composer: addComposerImages(emptyComposerState(), [
            { id: "draft-cache", name: "cache.png", attachment },
          ]),
          thread: emptyThread(),
          onDraftChange: () => undefined,
          onInterrupt: async () => undefined,
          onReadAttachment: async () => new Uint8Array([1, 2, 3, 4]),
          onRespondToApproval: async () => undefined,
          onSubmit: async () => undefined,
        }),
      );

    for (let index = 1; index <= 40; index += 1) {
      await act(async () => void renderAttachment(attachmentAt(index)));
      await act(async () => Promise.resolve());
    }
    const recentSrc = required<HTMLImageElement>(".draft-image img").src;
    assert.ok(revoked.includes(created[0] ?? "missing-first-url"));
    assert.ok(!revoked.includes(recentSrc));

    await act(async () => root.render(null));
    await act(async () => void renderAttachment(attachmentAt(40)));
    assert.equal(required<HTMLImageElement>(".draft-image img").src, recentSrc);
    assert.equal(created.length, 40);
  });
});

test("draft image remove badge keeps an 18px circle inside accessible pointer targets", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.remove-draft-image\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/su,
  );
  assert.match(styles, /\.remove-draft-image::before\s*\{[^}]*inset:\s*3px;/su);
  assert.match(
    styles,
    /@media \(pointer: coarse\), \(max-width: 720px\)\s*\{[\s\S]*?\.remove-draft-image\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/u,
  );
});

async function withDom(
  run: (dom: JSDOM, root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    {
      url: "http://localhost",
    },
  );
  const previous = {
    Blob: globalThis.Blob,
    document: globalThis.document,
    File: globalThis.File,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    URL: globalThis.URL,
    window: globalThis.window,
  };
  Object.assign(dom.window.URL, {
    createObjectURL: () => "blob:zenx-image",
    revokeObjectURL: () => undefined,
  });
  Object.assign(globalThis, {
    Blob: dom.window.Blob,
    document: dom.window.document,
    File: dom.window.File,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    URL: dom.window.URL,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await run(dom, root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

function required<T extends Element = Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  assert.ok(value, `Missing ${selector}`);
  return value;
}

function emptyThread(): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "provider",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

test("Markdown data and local images share keyboard-dismissable full-window previews", async () => {
  const { Markdown } = await import("../src/renderer/src/Markdown.js");
  const { ThreadImagesContext } =
    await import("../src/renderer/src/ImagePresentation.js");
  await withDom(async (dom, root) => {
    const reads: unknown[][] = [];
    Object.assign(window, {
      zenx: {
        imageAttachments: {
          readLocal: async (...args: unknown[]) => {
            reads.push(args);
            return { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
          },
        },
      },
    });
    const context = {
      cwd: "/workspace",
      attachments: {},
      read: async () => new Uint8Array(),
      open: () => {},
    };
    await act(async () =>
      root.render(
        createElement(
          ThreadImagesContext.Provider,
          { value: context },
          createElement(Markdown, {
            text: "![inline](data:image/png;base64,AA==)\n\n![local](./image.png)",
          }),
        ),
      ),
    );
    assert.deepEqual(reads, [["./image.png", "/workspace"]]);
    assert.equal(document.querySelectorAll(".markdown-image img").length, 2);
    const trigger = required<HTMLButtonElement>(
      '[aria-label="Preview inline"]',
    );
    await act(async () => trigger.click());
    const dialog = required<HTMLElement>('[role="dialog"]');
    assert.equal(dialog.parentElement, document.body);
    assert.equal(
      dialog.querySelector("img")?.getAttribute("src"),
      "data:image/png;base64,AA==",
    );
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    const local = required<HTMLButtonElement>('[aria-label="Preview local"]');
    await act(async () => local.click());
    assert.ok(document.querySelector('[role="dialog"] img'));
    await act(async () =>
      required<HTMLButtonElement>('[aria-label="Close image preview"]').click(),
    );
    assert.equal(document.activeElement, local);
  });
});

test("Markdown missing local images show an explanation and plain paths stay text", async () => {
  const { Markdown } = await import("../src/renderer/src/Markdown.js");
  await withDom(async (_dom, root) => {
    Object.assign(window, {
      zenx: {
        imageAttachments: {
          readLocal: async () => {
            throw new Error("missing");
          },
        },
      },
    });
    await act(async () =>
      root.render(
        createElement(Markdown, {
          text: "![missing](/tmp/missing.png)\n\n/tmp/plain.png",
        }),
      ),
    );
    assert.match(
      required<HTMLElement>('[role="alert"]').textContent ?? "",
      /Image unavailable: missing/,
    );
    assert.equal(document.querySelectorAll(".markdown-image").length, 1);
    assert.match(document.body.textContent ?? "", /\/tmp\/plain.png/);
    assert.equal(required<HTMLButtonElement>(".markdown-image").disabled, true);
  });
});

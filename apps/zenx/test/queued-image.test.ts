import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryAttachmentStore } from "../../../src/attachment.js";
import { act, draft, withRuntimeDom } from "./agent-runtime-dom.js";
import { projectQueuedImages } from "../src/renderer/src/queued-message-images.js";
import {
  applyQueueItem,
  cancelQueueFact,
  drainQueueHead,
  queueItem,
  queueScenario,
} from "./fixtures/agent-queue-data.js";
import {
  queueImageAttachments,
  missingQueueImage,
} from "./fixtures/agent-queue-images.js";
import {
  runtimeApproval,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";

const imageBytes = await Promise.all(
  queueImageAttachments.map((_image, index) =>
    readFile(
      new URL(
        `./fixtures/assets/queue-images/queue-image-${index + 1}.png`,
        import.meta.url,
      ),
    ),
  ),
);
const readImage = async (attachment: { sha256: string }) => {
  const index = queueImageAttachments.findIndex(
    (x) => x.sha256 === attachment.sha256,
  );
  assert.ok(index >= 0, "only locally generated fixture images are read");
  return new Uint8Array(imageBytes[index]!);
};
const imageButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>(
    ".queue-row .image-thumbnail",
  ),
];
const flush = async () => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

test("generated queue PNG bytes agree with canonical content-addressed references", async () => {
  const store = new InMemoryAttachmentStore();
  for (const expected of queueImageAttachments) {
    assert.deepEqual(
      await store.importBytes(await readImage(expected), "image/png"),
      expected,
    );
  }
});

test("queue images come only from native pending inputs with exact id and client identity", () => {
  const thread = queueScenario(2);
  assert.deepEqual(projectQueuedImages(thread), {
    "queue-0": queueImageAttachments.slice(0, 2),
    "queue-1": [queueImageAttachments[2]],
  });
  const mismatched = {
    ...thread,
    queuedMessages: thread.queuedMessages!.map((x) => ({
      ...x,
      clientId: "another-client",
    })),
  };
  assert.deepEqual(projectQueuedImages(mismatched), {});
  assert.deepEqual(
    projectQueuedImages({ ...thread, canonicalItems: undefined }),
    {},
  );
  assert.deepEqual(projectQueuedImages(null), {});
});

test("accepted and cancelled native inputs lose queue image references without altering history", () => {
  const original = queueScenario(2);
  const cancelled = cancelQueueFact(original, "queue-1", "queue-client-1");
  assert.deepEqual(Object.keys(projectQueuedImages(cancelled)), ["queue-0"]);
  const drained = drainQueueHead(cancelled);
  assert.deepEqual(projectQueuedImages(drained), {});
  assert.equal(
    drained.canonicalItems!.filter((x) => x.type === "user_message_queued")
      .length,
    2,
  );
});

test("text plus images and image-only inputs render real attachment thumbnails without nesting buttons", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(2), { onReadAttachment: readImage });
    await flush();
    assert.equal(imageButtons().length, 3);
    assert.equal(
      document.querySelectorAll('.queue-row img[src^="blob:"]').length,
      3,
    );
    assert.equal(
      document.querySelectorAll(
        '.queue-preview[role="button"] .image-thumbnail',
      ).length,
      0,
    );
    assert.match(
      document.querySelector('[data-queue-id="queue-0"]')!.textContent!,
      /2 images/u,
    );
    assert.match(
      document.querySelector('[data-queue-id="queue-1"]')!.textContent!,
      /1 image/u,
    );
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("legacy image count remains truthful when canonical references are unavailable", async () => {
  await withRuntimeDom(async (h) => {
    let reads = 0;
    const thread = { ...queueScenario(2), canonicalItems: undefined };
    await h.render(thread, {
      onReadAttachment: async () => {
        reads++;
        return new Uint8Array();
      },
    });
    assert.equal(imageButtons().length, 0);
    assert.match(
      document.querySelector(".queue-shelf")!.textContent!,
      /2 images/u,
    );
    assert.match(
      document.querySelector(".queue-shelf")!.textContent!,
      /1 image/u,
    );
    assert.equal(reads, 0);
  });
});

test("many images show three previews and an explicit disclosure preserving native image order", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(8), { onReadAttachment: readImage });
    await flush();
    const row = document.querySelector('[data-queue-id="queue-0"]')!;
    assert.equal(row.querySelectorAll(".image-thumbnail").length, 3);
    const more = row.querySelector<HTMLButtonElement>(".queue-images-more");
    assert.ok(more);
    assert.match(more.textContent!, /3/u);
    await act(async () => more.click());
    await flush();
    assert.equal(row.querySelectorAll(".image-thumbnail").length, 6);
    assert.match(row.textContent!, /6 images/u);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("collapsed approval queue and hidden rows do not read attachments before disclosure", async () => {
  await withRuntimeDom(async (h) => {
    const reads: string[] = [];
    const onReadAttachment = async (ref: { sha256: string }) => {
      reads.push(ref.sha256);
      throw new Error("not loaded in this test");
    };
    let thread = applyQueueItem(
      queueScenario(0),
      queueItem(8, [{ type: "image", attachment: queueImageAttachments[5]! }]),
    );
    await h.render(thread, { approvals: [runtimeApproval], onReadAttachment });
    assert.equal(imageButtons().length, 0);
    assert.deepEqual(reads, []);
    await h.click(".queue-shelf-toggle");
    assert.deepEqual(reads, []);
    await h.click(".queue-view-all");
    await flush();
    assert.equal(imageButtons().length, 1);
  });
});

test("queue image preview Escape closes only the viewer and returns focus without queue mutation", async () => {
  await withRuntimeDom(async (h) => {
    let mutations = 0;
    await h.render(queueScenario(2), {
      onReadAttachment: readImage,
      onSubmit: async () => {
        mutations++;
      },
      onCancelQueued: async () => {
        mutations++;
        return { results: [] };
      },
    });
    await flush();
    const trigger = imageButtons()[0]!;
    await act(async () => trigger.click());
    assert.ok(document.querySelector(".image-preview-layer"));
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(mutations, 0);
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("canonical cancellation closes an owned queue viewer and does not steal newer focus", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(2);
    await h.render(thread, { onReadAttachment: readImage });
    await flush();
    await act(async () => imageButtons()[2]!.click());
    assert.ok(document.querySelector(".image-preview-layer"));
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => composer.focus());
    await h.render(cancelQueueFact(thread, "queue-1", "queue-client-1"), {
      onReadAttachment: readImage,
    });
    await flush();
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.querySelectorAll(".queue-row").length, 1);
    assert.equal(document.activeElement, composer);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("switching thread closes the previous queue viewer without moving focus into old thread", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(2), { onReadAttachment: readImage });
    await flush();
    await act(async () => imageButtons()[0]!.click());
    const other = runtimeThread([], "completed", "other-thread");
    await h.render(other, { onReadAttachment: readImage });
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => composer.focus());
    await flush();
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.activeElement, composer);
    assert.equal(composer.value, draft.draft.text);
  });
});

test("unavailable queue image offers a bounded retry and never exposes a raw host path", async () => {
  await withRuntimeDom(async (h) => {
    let reads = 0;
    await h.render(queueScenario(9), {
      onReadAttachment: async () => {
        reads++;
        throw new Error("/private/host/secret-image.png unavailable");
      },
    });
    await flush();
    const failed = document.querySelector(
      '[data-queue-id="queue-0"] .image-thumbnail',
    )!;
    assert.match(failed.getAttribute("title")!, /unavailable/iu);
    assert.match(
      failed.querySelector('[role="alert"]')!.getAttribute("aria-label")!,
      /unavailable/iu,
    );
    assert.match(failed.textContent!, /Retry/iu);
    assert.doesNotMatch(
      document.querySelector(".queue-shelf")!.textContent!,
      /private\/host/u,
    );
    const before = reads;
    const first = imageButtons()[0]!;
    assert.equal(first.disabled, false);
    await act(async () => first.click());
    await flush();
    assert.equal(reads, before + 1);
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
  });
});

test("late attachment read after thread replacement cannot show an old thumbnail or reopen preview", async () => {
  await withRuntimeDom(async (h) => {
    let resolve!: (bytes: Uint8Array) => void;
    const thread = applyQueueItem(
      runtimeThread(),
      queueItem(90, [
        {
          type: "image",
          attachment: { ...missingQueueImage, sha256: "e".repeat(64) },
        },
      ]),
    );
    await h.render(thread, {
      onReadAttachment: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await flush();
    assert.equal(imageButtons()[0]!.disabled, true);
    await h.render(runtimeThread([], "completed", "replacement-thread"));
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => composer.focus());
    await act(async () => resolve(await readImage(queueImageAttachments[0]!)));
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(imageButtons().length, 0);
    assert.equal(document.activeElement, composer);
  });
});

test("accepted image input closes queue-owned preview while its transcript reference remains canonical", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(2);
    await h.render(thread, { onReadAttachment: readImage });
    await flush();
    await act(async () => imageButtons()[0]!.click());
    const accepted = drainQueueHead(thread);
    await h.render(accepted, { onReadAttachment: readImage });
    await flush();
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.querySelectorAll(".queue-row").length, 1);
    assert.ok(
      accepted.canonicalItems!.some(
        (x) => x.type === "user_message" && x.clientId === "queue-client-0",
      ),
    );
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("changing queue display order preserves exact image identity rather than array-index association", () => {
  const thread = queueScenario(2);
  const reordered = {
    ...thread,
    queuedMessages: [...thread.queuedMessages!].reverse(),
  };
  const images = projectQueuedImages(reordered);
  assert.deepEqual(images["queue-0"], queueImageAttachments.slice(0, 2));
  assert.deepEqual(images["queue-1"], [queueImageAttachments[2]]);
});

test("lazy thumbnails read bytes only after their own intersection is visible", async () => {
  const prior = globalThis.IntersectionObserver;
  const observers: {
    callback: IntersectionObserverCallback;
    target?: Element;
    disconnected: boolean;
  }[] = [];
  class FakeObserver {
    entry: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.target = target;
    }
    disconnect() {
      this.entry.disconnected = true;
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  Object.assign(globalThis, { IntersectionObserver: FakeObserver });
  try {
    await withRuntimeDom(async (h) => {
      let reads = 0;
      const thread = applyQueueItem(
        runtimeThread(),
        queueItem(91, [
          {
            type: "image",
            attachment: { ...missingQueueImage, sha256: "d".repeat(64) },
          },
        ]),
      );
      await h.render(thread, {
        onReadAttachment: async () => {
          reads++;
          throw new Error("simulated unavailable");
        },
      });
      assert.equal(reads, 0);
      const observer = observers.find((x) =>
        x.target?.classList.contains("image-thumbnail"),
      )!;
      assert.ok(observer);
      await act(async () =>
        observer.callback(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
      assert.equal(reads, 0);
      await act(async () =>
        observer.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
      assert.equal(reads, 1);
      assert.equal(observer.disconnected, true);
    });
  } finally {
    Object.assign(globalThis, { IntersectionObserver: prior });
  }
});

test("image viewer background dismissal preserves queue and main draft", async () => {
  await withRuntimeDom(async (h) => {
    let cancelCalls = 0;
    const thread = queueScenario(2);
    await h.render(thread, {
      onReadAttachment: readImage,
      onCancelQueued: async () => {
        cancelCalls++;
        return { results: [] };
      },
    });
    await flush();
    const trigger = imageButtons()[0]!;
    await act(async () => trigger.click());
    const layer = document.querySelector(".image-preview-layer")!;
    await act(async () =>
      layer.dispatchEvent(
        new window.MouseEvent("pointerdown", { bubbles: true }),
      ),
    );
    assert.equal(document.querySelector(".image-preview-layer"), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(cancelCalls, 0);
    assert.equal(document.querySelectorAll(".queue-row").length, 2);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

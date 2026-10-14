import assert from "node:assert/strict";
import test from "node:test";
import { act, draft, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  queueScenario,
  cancelQueueFact,
  drainQueueHead,
  applyQueueItem,
  queueItem,
} from "./fixtures/agent-queue-data.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { runtimeApproval } from "./fixtures/agent-runtime-data.js";
const rows = () => [
  ...document.querySelectorAll<HTMLElement>(".queue-shelf li"),
];
const noop = async () => ({ results: [] });
test("text plus images retain both text and attachment count", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(2), { onCancelQueued: noop });
    assert.match(rows()[0]!.textContent!, /2 images/u);
    assert.match(rows()[1]!.textContent!, /1 image/u);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});
test("many queue has two visible previews with bounded disclosure", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(3), { onCancelQueued: noop });
    assert.equal(rows().filter((x) => !x.hidden).length, 2);
    await h.click(".queue-view-all");
    assert.equal(rows().filter((x) => !x.hidden).length, 6);
  });
});
test("native cancellation and drain facts retain original queue history", () => {
  let t = queueScenario(2);
  t = cancelQueueFact(t, "queue-1", "queue-client-1");
  assert.deepEqual(
    t.queuedMessages?.map((x) => x.id),
    ["queue-0"],
  );
  t = drainQueueHead(t);
  assert.equal(t.queuedMessages?.length, 0);
  assert.equal(
    t.canonicalItems?.filter((x) => x.type === "user_message_queued").length,
    2,
  );
});
test("pending cancellation remains in same action without optimistic removal", async () => {
  await withRuntimeDom(async (h) => {
    let done!: (value: { results: [] }) => void;
    await h.render(queueScenario(2), {
      onCancelQueued: () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    });
    const target =
      rows()[1]!.querySelector<HTMLButtonElement>(".queue-row-cancel")!;
    await act(async () => target.click());
    assert.equal(rows().length, 2);
    assert.equal(rows()[1]!.querySelector(".queue-row-cancel"), target);
    assert.equal(target.disabled, true);
    assert.ok(target.querySelector('[role="status"]'));
    assert.equal(
      rows()[1]!.querySelector(".queue-row-main > .queue-row-pending"),
      null,
    );
    await act(async () => done({ results: [] }));
    assert.equal(rows().length, 2);
  });
});

test("row order and disclosure survive append, hide and authoritative head drain", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(3);
    await h.render(thread);
    const original = rows()[0];
    await h.click(".queue-view-all");
    await h.click('[data-queue-id="queue-2"] .queue-preview');
    assert.equal(
      rows()[2]!.querySelector(".queue-preview")?.getAttribute("aria-expanded"),
      "true",
    );
    await h.click(".queue-view-all");
    await h.click(".queue-view-all");
    assert.equal(rows()[0], original);
    assert.equal(
      rows()[2]!.querySelector(".queue-preview")?.getAttribute("aria-expanded"),
      "true",
    );
    thread = drainQueueHead(thread);
    await h.render(thread);
    assert.deepEqual(
      rows().map((x) => x.dataset.queueId),
      ["queue-1", "queue-2", "queue-3", "queue-4", "queue-5"],
    );
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("hidden native failure is discoverable and reveals the exact row", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(3), {
      queueFailure: {
        queuedItemId: "queue-4",
        code: "provider",
        message: "Exact fifth input rejected",
      },
    });
    assert.ok(rows()[4]!.hidden);
    assert.match(
      document.querySelector(".queue-hidden-failure")!.textContent!,
      /Exact fifth/u,
    );
    await h.click(".queue-hidden-failure");
    assert.equal(rows()[4]!.hidden, false);
    assert.match(
      rows()[4]!.querySelector(".queue-row-error")!.textContent!,
      /Exact fifth/u,
    );
    assert.equal(rows()[0]!.querySelector(".queue-row-error"), null);
  });
});

test("native second-row failure stays attached while retry transport error is control-level", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(5);
    const props = {
      queueFailure: {
        queuedItemId: "queue-1",
        code: "image_preflight",
        message: "Second image rejected",
      },
      onResumeQueue: async () => {
        throw new Error("Connection lost");
      },
    };
    await h.render(thread, props);
    await h.click(".queue-resume");
    assert.match(
      rows()[1]!.querySelector(".queue-row-error")!.textContent!,
      /Second image rejected/u,
    );
    assert.equal(rows()[0]!.querySelector(".queue-row-error"), null);
    assert.match(
      document.querySelector(".queue-resume-error")!.textContent!,
      /Connection lost/u,
    );
    assert.equal(rows().length, 2);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("only a fresh same-attempt native failure deduplicates the matching resume error", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(5);
    let reject!: (e: Error) => void;
    const props = {
      onResumeQueue: () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    };
    await h.render(thread, props);
    await h.click(".queue-resume");
    await h.render(thread, {
      ...props,
      queueFailure: {
        queuedItemId: "queue-1",
        code: "image",
        attemptId: "new-resume-attempt",
        message: "Second image rejected",
      },
    });
    await act(async () => reject(new Error("Second image rejected")));
    assert.ok(!document.querySelector(".queue-resume-error"));
    assert.equal(document.querySelectorAll(".queue-row-error").length, 1);
    assert.ok(rows()[1]!.querySelector(".queue-row-error"));
  });
});

test("an older same-text native failure cannot swallow a new resume transport error", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(5), {
      queueFailure: {
        queuedItemId: "queue-1",
        code: "old-provider",
        attemptId: "previous-attempt",
        message: "Connection lost",
      },
      onResumeQueue: async () => {
        throw new Error("Connection lost");
      },
    });
    await h.click(".queue-resume");
    assert.ok(rows()[1]!.querySelector(".queue-row-error"));
    assert.match(
      document.querySelector(".queue-resume-error")?.textContent ?? "",
      /Connection lost/u,
    );
  });
});

test("resume failure retires when the captured head drains while later inputs remain", async () => {
  await withRuntimeDom(async (h) => {
    let thread = queueScenario(5);
    const props = {
      onResumeQueue: async () => {
        throw new Error("Old attempt disconnected");
      },
    };
    await h.render(thread, props);
    await h.click(".queue-resume");
    assert.ok(document.querySelector(".queue-resume-error"));
    thread = drainQueueHead(thread);
    await h.render(thread, props);
    assert.equal(rows().length, 1);
    assert.ok(
      !document.querySelector(".queue-resume-error"),
      "stale resume error must retire",
    );
  });
});

test("explicit full-text reading survives approval arrival; header collapses in one action", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(2);
    await h.render(thread);
    await h.click('.queue-preview[role="button"]');
    await h.render(thread, { approvals: [runtimeApproval] });
    assert.equal(
      document
        .querySelector(".queue-shelf-toggle")
        ?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      document.querySelector(".queue-preview")?.getAttribute("aria-expanded"),
      "true",
    );
    await h.click(".queue-shelf-toggle");
    assert.equal(
      document
        .querySelector(".queue-shelf-toggle")
        ?.getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      document.querySelector<HTMLElement>(".queue-shelf-details")?.hidden,
      true,
    );
    await h.render({ ...thread, id: "other-thread" }, { approvals: [] });
    assert.equal(
      document.querySelector(".queue-preview")?.getAttribute("aria-expanded"),
      "false",
    );
  });
});

test("focused queue controls are preserved when an approval arrives", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(0);
    await h.render(thread, { onCancelQueued: noop });
    const button =
      rows()[0]!.querySelector<HTMLButtonElement>(".queue-row-cancel")!;
    await act(async () => button.focus());
    await h.render(thread, {
      onCancelQueued: noop,
      approvals: [runtimeApproval],
    });
    assert.equal(document.activeElement, button);
    assert.equal(
      document
        .querySelector(".queue-shelf-toggle")
        ?.getAttribute("aria-expanded"),
      "true",
    );
  });
});

test("canonical focused-row removal returns to an enabled control even while cancellation is pending", async () => {
  await withRuntimeDom(async (h) => {
    let done!: (r: { results: [] }) => void;
    let thread = queueScenario(0);
    const props = {
      onCancelQueued: () =>
        new Promise<{ results: [] }>((r) => {
          done = r;
        }),
    };
    await h.render(thread, props);
    const button =
      rows()[0]!.querySelector<HTMLButtonElement>(".queue-row-cancel")!;
    await act(async () => {
      button.focus();
      button.click();
    });
    thread = drainQueueHead(thread);
    await h.render(thread, props);
    assert.notEqual(document.activeElement, document.body);
    assert.equal((document.activeElement as HTMLButtonElement).disabled, false);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
    await act(async () => done({ results: [] }));
  });
});

test("last-row drain returns owned focus to Composer and preserves its draft", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(1);
    await h.render(thread, { onCancelQueued: noop });
    await act(async () =>
      rows()[0]!.querySelector<HTMLButtonElement>(".queue-row-cancel")!.focus(),
    );
    await h.render(drainQueueHead(thread), { onCancelQueued: noop });
    assert.ok(!document.querySelector(".queue-shelf"));
    assert.ok(
      document.activeElement === document.querySelector("textarea"),
      "Composer should own focus",
    );
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("intentional blur and outside transcript selection are not stolen on queue drain", async () => {
  await withRuntimeDom(async (h) => {
    const thread = queueScenario(1);
    await h.render(thread, { onCancelQueued: noop });
    const button =
      rows()[0]!.querySelector<HTMLButtonElement>(".queue-row-cancel")!;
    await act(async () => {
      button.focus();
      button.blur();
      const range = document.createRange();
      range.selectNodeContents(
        document.querySelector(".messages-inner article p")!,
      );
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const selected = document.getSelection()!.toString();
    await h.render(drainQueueHead(thread), { onCancelQueued: noop });
    assert.ok(
      document.activeElement === document.body,
      "outside focus should remain untouched",
    );
    assert.equal(document.getSelection()!.toString(), selected);
  });
});

test("bulk cancellation takes an exact snapshot and excludes a later append", async () => {
  await withRuntimeDom(async (h) => {
    let targets: unknown;
    let thread = queueScenario(0);
    const props = {
      onCancelQueued: async (input: unknown) => {
        targets = input;
        return { results: [] };
      },
    };
    await h.render(thread, props);
    await h.click('[data-queue-control="cancel-all"]');
    thread = applyQueueItem(
      thread,
      queueItem(2, [{ type: "text", text: "New later input" }]),
    );
    await h.render(thread, props);
    await h.click(".queued-cancel-confirmation-actions button:last-child");
    assert.deepEqual(targets, [
      { queuedItemId: "queue-0", clientId: "queue-client-0" },
      { queuedItemId: "queue-1", clientId: "queue-client-1" },
    ]);
    assert.equal(rows().length, 3);
  });
});

test("same-tick cancel and resume are mutually exclusive", async () => {
  for (const first of ["cancel", "resume"]) {
    await withRuntimeDom(async (h) => {
      let cancelled = 0,
        resumed = 0,
        finish!: (r: { results: [] }) => void,
        continueDone!: () => void;
      await h.render(queueScenario(5), {
        onCancelQueued: () => {
          cancelled++;
          return new Promise((r) => {
            finish = r;
          });
        },
        onResumeQueue: () => {
          resumed++;
          return new Promise((r) => {
            continueDone = r;
          });
        },
      });
      const cancel =
          document.querySelector<HTMLButtonElement>(".queue-row-cancel")!,
        resume = document.querySelector<HTMLButtonElement>(".queue-resume")!;
      await act(async () => {
        if (first === "cancel") {
          cancel.click();
          resume.click();
        } else {
          resume.click();
          cancel.click();
        }
      });
      assert.equal(cancelled + resumed, 1, first);
      await act(async () => {
        finish?.({ results: [] });
        continueDone?.();
      });
    });
  }
});

test("bulk dialog dismissal after queue drain returns to Composer without mutation", async () => {
  await withRuntimeDom(async (h) => {
    let calls = 0,
      thread = queueScenario(0);
    const props = {
      onCancelQueued: async () => {
        calls++;
        return { results: [] };
      },
    };
    await h.render(thread, props);
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-queue-control="cancel-all"]',
    )!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    thread = drainQueueHead(drainQueueHead(thread));
    await h.render(thread, props);
    await h.click(".queued-cancel-confirmation-actions button:first-child");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(calls, 0);
    assert.ok(
      document.activeElement === document.querySelector("textarea"),
      "Composer should own focus",
    );
  });
});

test("per-thread cancellation locks survive A to B to A and resolve independently", async () => {
  await withRuntimeDom(async (h) => {
    const a = queueScenario(0),
      b = { ...a, id: "thread-b" };
    let calls = 0;
    const resolvers: Array<(r: { results: [] }) => void> = [];
    const props = {
      onCancelQueued: () => {
        calls++;
        return new Promise<{ results: [] }>((r) => resolvers.push(r));
      },
    };
    await h.render(a, props);
    await h.click(".queue-row-cancel");
    await h.render(b, props);
    await h.click(".queue-row-cancel");
    await h.render(a, props);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-row-cancel")?.disabled,
      true,
    );
    await act(async () => resolvers[1]!({ results: [] }));
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-row-cancel")?.disabled,
      true,
    );
    await act(async () => resolvers[0]!({ results: [] }));
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-row-cancel")?.disabled,
      false,
    );
    assert.equal(calls, 2);
    assert.equal(rows().length, 2);
  });
});

test("late queue failures stay in their owning thread", async () => {
  await withRuntimeDom(async (h) => {
    const a = queueScenario(5),
      b = { ...a, id: "thread-b" };
    let reject!: (e: Error) => void;
    const props = {
      onResumeQueue: () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    };
    await h.render(a, props);
    await h.click(".queue-resume");
    await h.render(b, props);
    await act(async () => reject(new Error("Failure from old A")));
    assert.doesNotMatch(document.body.textContent!, /Failure from old A/u);
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("full-text keyboard disclosure works with Enter and Space without mutating Composer", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(queueScenario(2));
    const preview = document.querySelector<HTMLElement>(
      '.queue-preview[role="button"]',
    )!;
    await act(async () => {
      preview.focus();
      preview.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    assert.equal(preview.getAttribute("aria-expanded"), "true");
    await act(async () =>
      preview.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      ),
    );
    assert.equal(preview.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("Chinese queue header exposes actual one and many counts rather than an untranslated key", async () => {
  try {
    await i18n.changeLanguage("zh-CN");
    await withRuntimeDom(async (h) => {
      await h.render(queueScenario(1));
      assert.match(
        document.querySelector(".queue-shelf-toggle")!.textContent!,
        /1/u,
      );
      await h.render(queueScenario(3));
      assert.match(
        document.querySelector(".queue-shelf-toggle")!.textContent!,
        /6/u,
      );
      assert.doesNotMatch(
        document.querySelector(".queue-shelf-toggle")!.textContent!,
        /queuePendingCount/u,
      );
    });
  } finally {
    await i18n.changeLanguage("en");
  }
});

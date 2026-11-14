import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PendingSendRows } from "../src/renderer/src/PendingSendRows.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  emptyComposerState,
  beginImmediateComposerSubmission,
  editComposer,
  reconcileCanonicalAdmission,
  reconcilePendingSendPresentations,
  type ComposerState,
  type PendingSendPresentation,
} from "../src/renderer/src/composer-state.js";

function pending(clientId = "one"): PendingSendPresentation {
  return {
    clientId,
    intent: "start",
    draft: { text: `Synthetic ${clientId}`, images: [] },
    status: "unconfirmed",
    error: "Original admission outcome unknown",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function withRows(run: (root: Root) => Promise<void>) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    Object.assign(globalThis, {
      document: previousDocument,
      window: previousWindow,
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

function renderRows(
  root: Root,
  messages: readonly PendingSendPresentation[],
  onCheck: () => Promise<"checked" | "unavailable">,
  key = "thread-one",
) {
  root.render(
    createElement(PendingSendRows, {
      key,
      messages,
      onCheck,
      onReadAttachment: async () => new Uint8Array(),
      onOpenImage: () => undefined,
    }),
  );
}

function row(id = "one"): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-pending-send-client-id="${id}"]`,
  );
  assert.ok(element, `Expected pending row ${id}`);
  return element;
}

function checkButton(id = "one"): HTMLButtonElement {
  const button = [...row(id).querySelectorAll("button")].find((element) =>
    ["Check delivery", "检查送达状态"].includes(element.textContent ?? ""),
  );
  assert.ok(button, `Expected check action for ${id}`);
  return button;
}

function feedback(id = "one"): HTMLElement {
  const element = row(id).querySelector<HTMLElement>(
    ".pending-send-check-feedback",
  );
  assert.ok(element, `Expected visible check feedback for ${id}`);
  return element;
}

test("delivery check visibly progresses and retains a qualified result for only the requested input", async () => {
  await withRows(async (root) => {
    const read = deferred<"checked">();
    let reads = 0;
    const onCheck = () => {
      reads++;
      return read.promise;
    };
    const one = pending();
    const two = pending("two");
    await act(async () => renderRows(root, [one, two], onCheck));
    await act(async () => {
      checkButton().click();
      checkButton().click();
    });
    assert.equal(reads, 1, "Same-frame repeat activation starts only one read");
    assert.equal(checkButton().disabled, true);
    assert.equal(feedback().getAttribute("role"), "status");
    assert.equal(feedback().getAttribute("aria-atomic"), "true");
    assert.equal(feedback().getAttribute("data-check-state"), "checking");
    assert.match(feedback().textContent ?? "", /Checking delivery/);
    assert.equal(
      row("two").querySelector(".pending-send-check-feedback"),
      null,
    );
    await act(async () => {
      read.resolve("checked");
      await read.promise;
    });
    assert.equal(feedback().getAttribute("data-check-state"), "completed");
    assert.equal(
      feedback().textContent,
      "Check completed. Delivery is still unconfirmed.",
    );
    assert.equal(checkButton().disabled, false);
    assert.equal(row().getAttribute("data-send-state"), "unconfirmed");
    await act(async () =>
      renderRows(
        root,
        [{ ...one, recovered: true }, two, pending("new")],
        onCheck,
      ),
    );
    assert.match(feedback().textContent ?? "", /Delivery is still unconfirmed/);
    assert.equal(
      row("new").querySelector(".pending-send-check-feedback"),
      null,
    );
    assert.match(row().textContent ?? "", /may already have been accepted/);
    assert.equal(
      reads,
      1,
      "Recovery and new inputs never automatically check or resend",
    );
  });
});

test("unavailable and failed checks remain distinct from completed reads and allow an explicit retry", async () => {
  await withRows(async (root) => {
    const replies = [
      () => Promise.resolve("unavailable" as const),
      () => Promise.reject(new Error("Synthetic read unavailable")),
      () => Promise.resolve("checked" as const),
    ];
    let reads = 0;
    await act(async () =>
      renderRows(root, [pending()], () => replies[reads++]!()),
    );
    await act(async () => checkButton().click());
    assert.equal(feedback().getAttribute("data-check-state"), "unavailable");
    assert.match(feedback().textContent ?? "", /could not be completed/);
    assert.doesNotMatch(row().textContent ?? "", /Check completed\.|Not sent/);
    await act(async () => checkButton().click());
    assert.equal(feedback().getAttribute("data-check-state"), "failed");
    assert.equal(feedback().getAttribute("role"), "alert");
    assert.match(feedback().textContent ?? "", /Delivery check failed/);
    assert.match(row().textContent ?? "", /Synthetic read unavailable/);
    assert.equal(row().getAttribute("data-send-state"), "unconfirmed");
    await act(async () => checkButton().click());
    assert.equal(feedback().getAttribute("data-check-state"), "completed");
    assert.doesNotMatch(row().textContent ?? "", /Synthetic read unavailable/);
    assert.equal(reads, 3);
  });
});

test("admitted input keeps admission authority without calling an absent projection unconfirmed", async () => {
  await withRows(async (root) => {
    await act(async () =>
      renderRows(
        root,
        [{ ...pending(), status: "admitted" }],
        async () => "checked",
      ),
    );
    await act(async () => checkButton().click());
    assert.equal(
      feedback().textContent,
      "Check completed. Still waiting for the conversation to update.",
    );
    assert.equal(row().getAttribute("data-send-state"), "admitted");
    assert.doesNotMatch(
      row().textContent ?? "",
      /unconfirmed|not confirmed|Not sent/,
    );
  });
});

test("late admission retires an older check and its error without downgrading the row", async () => {
  await withRows(async (root) => {
    const read = deferred<"checked">();
    const input = pending();
    await act(async () => renderRows(root, [input], () => read.promise));
    await act(async () => checkButton().click());
    await act(async () =>
      renderRows(
        root,
        [{ ...input, status: "admitted" }],
        async () => "checked",
      ),
    );
    assert.equal(checkButton().disabled, false);
    assert.equal(row().querySelector(".pending-send-check-feedback"), null);
    await act(async () => {
      read.reject(new Error("Obsolete pre-admission read"));
      await read.promise.catch(() => undefined);
    });
    assert.doesNotMatch(
      row().textContent ?? "",
      /Obsolete|unconfirmed|not confirmed/,
    );
    await act(async () => checkButton().click());
    assert.match(feedback().textContent ?? "", /waiting for the conversation/);
  });
});

test("old check settlement cannot affect a replacement row with the same client ID", async () => {
  await withRows(async (root) => {
    for (const outcome of ["checked", "failed"] as const) {
      const old = deferred<"checked">();
      const current = deferred<"checked">();
      await act(async () => renderRows(root, [pending()], () => old.promise));
      await act(async () => checkButton().click());
      await act(async () => renderRows(root, [], () => old.promise));
      await act(async () =>
        renderRows(root, [pending()], () => current.promise),
      );
      await act(async () => checkButton().click());
      await act(async () => {
        if (outcome === "checked") old.resolve("checked");
        else old.reject(new Error("Obsolete removed-row read"));
        await old.promise.catch(() => undefined);
      });
      assert.equal(checkButton().disabled, true);
      assert.equal(feedback().getAttribute("data-check-state"), "checking");
      assert.doesNotMatch(row().textContent ?? "", /Obsolete|Check completed/);
      await act(async () => {
        current.resolve("checked");
        await current.promise;
      });
      assert.equal(feedback().getAttribute("data-check-state"), "completed");
      await act(async () => renderRows(root, [], async () => "checked"));
    }
  });
});

test("thread switch and return retire old check completion even with the same client ID", async () => {
  await withRows(async (root) => {
    const read = deferred<"checked">();
    await act(async () =>
      renderRows(root, [pending()], () => read.promise, "A"),
    );
    await act(async () => checkButton().click());
    await act(async () =>
      renderRows(root, [pending()], async () => "checked", "B"),
    );
    assert.equal(checkButton().disabled, false);
    assert.equal(row().querySelector(".pending-send-check-feedback"), null);
    await act(async () =>
      renderRows(root, [pending()], async () => "checked", "A"),
    );
    await act(async () => {
      read.resolve("checked");
      await read.promise;
    });
    assert.equal(row().querySelector(".pending-send-check-feedback"), null);
    assert.equal(checkButton().disabled, false);
  });
});

test("an empty canonical read preserves the copy and late exact canonical acceptance alone removes it", async () => {
  await withRows(async (root) => {
    let state = { ...emptyComposerState(), pendingSends: [pending()] };
    const read = deferred<"checked">();
    const render = () =>
      renderRows(root, state.pendingSends, () => read.promise);
    await act(async () => render());
    await act(async () => checkButton().click());
    state = reconcileCanonicalAdmission(state, []) as typeof state;
    await act(async () => {
      render();
      read.resolve("checked");
      await read.promise;
    });
    assert.equal(row().getAttribute("data-send-state"), "unconfirmed");
    assert.match(feedback().textContent ?? "", /still unconfirmed/);
    state = reconcileCanonicalAdmission(state, [
      {
        type: "user_message",
        id: "canonical-exact",
        createdAt: "2026-11-09T00:00:00Z",
        threadId: "thread-one",
        turnId: "turn-one",
        clientId: "one",
        text: "Synthetic one",
      },
    ]) as typeof state;
    await act(async () => render());
    assert.equal(document.querySelector("[data-pending-send-client-id]"), null);
    assert.equal(document.querySelector(".pending-send-check-feedback"), null);
  });
});

test("delivery check feedback is localized in Chinese", async () => {
  await withRows(async (root) => {
    await i18n.changeLanguage("zh-CN");
    await act(async () => renderRows(root, [pending()], async () => "checked"));
    await act(async () => checkButton().click());
    assert.match(feedback().textContent ?? "", /检查已完成.*仍未确认是否送达/);
    assert.doesNotMatch(
      feedback().textContent ?? "",
      /pendingSend|Check completed/,
    );
  });
});

test("full-read exact-copy reconciliation leaves newer submission and compaction authority unchanged", () => {
  const newer = editComposer(
    beginImmediateComposerSubmission(
      editComposer(emptyComposerState(), "Newer input being admitted"),
      "start",
      null,
      () => "newer-client",
    ),
    "Even newer editable draft",
  );
  const state: ComposerState = {
    ...newer,
    pendingSends: [pending(), ...newer.pendingSends!],
    compaction: {
      operationId: "newer-compaction",
      status: "pending",
      message: "Current compaction",
      startedAfterItemId: "current-fence",
      coveredThroughItemId: "current-boundary",
    },
    compactionRequest: { token: {}, operationId: "newer-compaction" },
  };
  const result = reconcilePendingSendPresentations(state, [
    {
      type: "user_message",
      id: "old-exact-receipt",
      clientId: "one",
      threadId: "thread-one",
      turnId: "old-turn",
      createdAt: "2026-11-09T00:00:00Z",
      text: "Synthetic one",
    },
  ]);
  assert.deepEqual(
    result.pendingSends?.map((item) => item.clientId),
    ["newer-client"],
  );
  assert.equal(result.submission, state.submission);
  assert.equal(result.draft, state.draft);
  assert.equal(result.draftRevision, state.draftRevision);
  assert.equal(result.compaction, state.compaction);
  assert.equal(result.compactionRequest, state.compactionRequest);
  assert.equal(result.confirmedAdmission, state.confirmedAdmission);
});

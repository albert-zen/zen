import assert from "node:assert/strict";
import test from "node:test";
import {
  act,
  draft,
  withRuntimeDom,
  type ViewProps,
} from "./agent-runtime-dom.js";
import {
  longApprovalCode,
  runtimeApproval,
  runtimeMessage,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";
import { queueScenario } from "./fixtures/agent-queue-data.js";
import type { ApprovalCardState } from "../src/renderer/src/approval-state.js";

const request = (requestId: string): ApprovalCardState => ({
  ...runtimeApproval,
  requestId,
  params: { ...runtimeApproval.params, itemId: `call-${requestId}` },
});
const card = (id: string) =>
  `.approval-request-card[data-approval-request="${id}"]`;
function button(selector: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(element, selector);
  return element;
}
async function press(selector: string) {
  const target = button(selector);
  await act(async () => {
    target.focus();
    target.click();
  });
  return target;
}
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 35)));
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("native once and remembered scopes retain full code, cwd and exact request details", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread();
    const once: ApprovalCardState = {
      ...request("once-request"),
      params: { ...runtimeApproval.params, approvalScope: "once" },
    };
    await h.render(thread, { approvals: [once] });
    assert.match(
      document.querySelector(".approval-request-scope")!.textContent!,
      /only/u,
    );
    assert.equal(
      button(".approval-request-allow").textContent?.trim(),
      "Allow once",
    );
    assert.equal(
      document.querySelector(".approval-request-preview code")!.textContent,
      longApprovalCode,
    );
    assert.equal(
      document.querySelector(".approval-request-cwd code")!.textContent,
      once.params.cwd,
    );
    await press(".approval-request-details");
    const technical = [
      ...document.querySelectorAll(".approval-request-dialog details"),
    ].find(
      (element) =>
        element.querySelector("summary")?.textContent === "Technical details",
    );
    assert.ok(technical);
    assert.deepEqual(
      JSON.parse(technical.querySelector("code")!.textContent!),
      {
        requestId: once.requestId,
        params: once.params,
      },
    );
    assert.equal(
      document
        .querySelector(".approval-request-dialog")
        ?.getAttribute("data-approval-thread"),
      thread.id,
    );
    await press(".approval-request-close");
    await settle();
    await h.render(thread, { approvals: [runtimeApproval] });
    assert.match(
      document.querySelector(".approval-request-scope")!.textContent!,
      /stable.*run_code.*not per command or code segment/u,
    );
    assert.equal(
      button(".approval-request-allow").textContent?.trim(),
      "Allow access",
    );
    assert.equal(document.querySelector(".approval-request-card select"), null);
  });
});

test("Escape and explicit close return to A's trigger with A and B present without deciding", async () => {
  await withRuntimeDom(async (h) => {
    let calls = 0;
    await h.render(runtimeThread(), {
      approvals: [request("a"), request("b")],
      onRespondToApproval: async () => {
        calls += 1;
      },
    });
    const trigger = await press(`${card("a")} .approval-request-details`);
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await settle();
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "dialog must be dismissed",
    );
    assert.ok(
      document.activeElement === trigger,
      "original A trigger must regain focus",
    );
    await press(`${card("a")} .approval-request-details`);
    await press(".approval-request-close");
    await settle();
    assert.ok(
      document.activeElement === trigger,
      "original A trigger must regain focus",
    );
    assert.equal(calls, 0);
  });
});

test("card and dialog share a same-tick decision lock and allow retry after a visible failure", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    const calls: Array<[string, string]> = [];
    await h.render(runtimeThread(), {
      approvals: [request("a")],
      onRespondToApproval: async (id, decision) => {
        calls.push([id, decision]);
        if (calls.length === 1) await attempt.promise;
      },
    });
    await press(".approval-request-details");
    const inline = button(`${card("a")} .approval-request-allow`);
    const modal = button(".approval-request-dialog .approval-request-allow");
    await act(async () => {
      modal.focus();
      modal.click();
      inline.click();
      modal.click();
    });
    assert.deepEqual(calls, [["a", "accept"]]);
    assert.equal(inline.disabled, true);
    assert.equal(modal.disabled, true);
    await act(async () =>
      attempt.reject(new Error("Exact approval transport failure")),
    );
    assert.equal(inline.disabled, false);
    assert.equal(modal.disabled, false);
    assert.match(
      document.querySelector(".approval-request-dialog [role='alert']")!
        .textContent!,
      /Exact approval transport failure/u,
    );
    await press(".approval-request-dialog .approval-request-deny");
    await settle();
    assert.deepEqual(calls, [
      ["a", "accept"],
      ["a", "decline"],
    ]);
    assert.ok(
      document.querySelector(".approval-request-error") === null,
      "stale approval error must be absent",
    );
  });
});

test("removed A cannot submit from a detached button or restore over focused B when its promise finishes", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    const calls: string[] = [];
    const response: ViewProps["onRespondToApproval"] = async (id) => {
      calls.push(id);
      await attempt.promise;
    };
    const thread = runtimeThread();
    await h.render(thread, {
      approvals: [request("a")],
      onRespondToApproval: response,
    });
    const oldDeny = button(`${card("a")} .approval-request-deny`);
    await press(`${card("a")} .approval-request-allow`);
    await h.render(thread, {
      approvals: [request("b")],
      onRespondToApproval: response,
    });
    const b = button(`${card("b")} .approval-request-details`);
    await act(async () => b.focus());
    await act(async () => {
      oldDeny.click();
      attempt.resolve();
    });
    await settle();
    assert.deepEqual(calls, ["a"]);
    assert.ok(document.activeElement === b, "B must retain focus");
    assert.ok(
      document.querySelector(".approval-request-error") === null,
      "stale approval error must be absent",
    );
  });
});

test("removing a request closes its dialog and never restores its disconnected trigger", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread();
    await h.render(thread, { approvals: [request("a")] });
    const oldTrigger = await press(".approval-request-details");
    await h.render(thread, { approvals: [request("b")] });
    const b = button(`${card("b")} .approval-request-details`);
    await act(async () => b.focus());
    await settle();
    assert.equal(oldTrigger.isConnected, false);
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "dialog must be dismissed",
    );
    assert.ok(document.activeElement === b, "B must retain focus");
  });
});

test("successful modal decision closes the focus trap before restoring the Composer", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(runtimeThread(), {
      approvals: [request("a")],
      onRespondToApproval: async () => {},
    });
    await press(".approval-request-details");
    await press(".approval-request-dialog .approval-request-allow");
    await settle();
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "dialog must be dismissed",
    );
    assert.ok(
      document.activeElement === document.querySelector("textarea"),
      "Composer must own focus after success",
    );
    assert.equal(document.querySelector("textarea")?.value, draft.draft.text);
  });
});

test("A's ordinary success still restores Composer when B was already present and unfocused", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    const response = async () => attempt.promise;
    const thread = runtimeThread();
    await h.render(thread, {
      approvals: [request("a"), request("b")],
      onRespondToApproval: response,
    });
    await press(`${card("a")} .approval-request-allow`);
    await h.render(thread, {
      approvals: [request("b")],
      onRespondToApproval: response,
    });
    await act(async () => attempt.resolve());
    await settle();
    assert.ok(
      document.activeElement === document.querySelector("textarea"),
      "Composer must own focus after success",
    );
    assert.ok(document.querySelector(card("b")));
  });
});

test("a late rejection from another thread cannot show its error or take the new Composer focus", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    await h.render(runtimeThread(), {
      approvals: [request("a")],
      onRespondToApproval: async () => attempt.promise,
    });
    await press(".approval-request-allow");
    await h.render(runtimeThread([], "inProgress", "next-thread"));
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => composer.focus());
    await act(async () =>
      attempt.reject(new Error("Old thread approval failure")),
    );
    await settle();
    assert.ok(
      document.querySelector(".approval-request-error") === null,
      "stale approval error must be absent",
    );
    assert.ok(
      document.activeElement === composer,
      "new Composer must retain focus",
    );
    assert.equal(composer.value, draft.draft.text);
  });
});

test("backdrop dismissal returns to the trigger without sending a decision", async () => {
  await withRuntimeDom(async (h) => {
    let calls = 0;
    await h.render(runtimeThread(), {
      approvals: [request("a")],
      onRespondToApproval: async () => {
        calls += 1;
      },
    });
    const trigger = await press(".approval-request-details");
    await settle();
    const overlay = document.querySelector(".ui-dialog-overlay");
    assert.ok(overlay);
    await act(async () =>
      overlay.dispatchEvent(
        new window.MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
        }),
      ),
    );
    await act(async () =>
      overlay.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, button: 0 }),
      ),
    );
    await settle();
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "dialog must be dismissed",
    );
    assert.ok(
      document.activeElement === trigger,
      "backdrop dismissal restores the original trigger",
    );
    assert.equal(calls, 0);
  });
});

test("late A completion cannot close B's newer dialog or steal its focus", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    const thread = runtimeThread();
    const response = async () => attempt.promise;
    await h.render(thread, {
      approvals: [request("a")],
      onRespondToApproval: response,
    });
    await press(`${card("a")} .approval-request-allow`);
    await h.render(thread, {
      approvals: [request("b")],
      onRespondToApproval: response,
    });
    await press(`${card("b")} .approval-request-details`);
    const newerDialog = document.querySelector(
      '.approval-request-dialog[data-approval-request="b"]',
    )!;
    assert.ok(newerDialog);
    const focusBefore = document.activeElement;
    await act(async () => attempt.resolve());
    await settle();
    assert.ok(newerDialog.isConnected);
    assert.ok(
      document.activeElement === focusBefore,
      "B dialog keeps its focused control",
    );
    assert.ok(newerDialog.contains(document.activeElement));
    assert.ok(
      document.querySelector(".approval-request-error") === null,
      "stale approval error must be absent",
    );
  });
});

test("late approval success preserves deliberate transcript selection even when a disabled approval button still owns focus", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    const text = "Preserve this transcript text for copying.";
    await h.render(runtimeThread([runtimeMessage("selectable", text)]), {
      approvals: [request("a")],
      onRespondToApproval: async () => attempt.promise,
    });
    const allow = await press(".approval-request-allow");
    const paragraph = document.querySelector(".agent-copy .markdown-body p");
    assert.ok(paragraph);
    await act(async () => {
      paragraph.dispatchEvent(
        new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    assert.ok(
      document.activeElement === allow,
      "text selection can leave focus on the disabled button",
    );
    assert.equal(window.getSelection()?.toString(), text);
    await act(async () => attempt.resolve());
    await settle();
    assert.ok(
      document.activeElement !== document.querySelector("textarea"),
      "a deliberate selection must prevent Composer autofocus",
    );
    assert.equal(window.getSelection()?.toString(), text);
  });
});

test("late approval success also preserves selection in queued text outside the transcript", async () => {
  await withRuntimeDom(async (h) => {
    const attempt = deferred();
    await h.render(queueScenario(0), {
      approvals: [request("a")],
      onRespondToApproval: async () => attempt.promise,
    });
    const toggle = button(".queue-shelf-toggle");
    if (toggle.getAttribute("aria-expanded") === "false")
      await press(".queue-shelf-toggle");
    const allow = await press(".approval-request-allow");
    const preview = document.querySelector(".queue-preview-text");
    assert.ok(preview);
    const text = preview.textContent;
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(preview);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    assert.ok(
      document.activeElement === allow,
      "queued text selection leaves disabled Allow focused",
    );
    assert.equal(window.getSelection()?.toString(), text);
    await act(async () => attempt.resolve());
    await settle();
    assert.ok(
      document.activeElement !== document.querySelector("textarea"),
      "queued selection must also prevent Composer autofocus",
    );
    assert.equal(window.getSelection()?.toString(), text);
  });
});

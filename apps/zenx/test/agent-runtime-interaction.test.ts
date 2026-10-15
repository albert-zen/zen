import assert from "node:assert/strict";
import test from "node:test";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  runtimeThread,
  runtimeTask,
  runtimeWait,
  runtimeCommand,
  runtimeMessage,
  runtimeApproval,
  confirmedStopped,
} from "./fixtures/agent-runtime-data.js";

test("native wait receipt stays static despite successful outer call; parallel running task remains active", async () => {
  await withRuntimeDom(async (h) => {
    const wait = runtimeWait("wait", "task-a");
    await h.render(runtimeThread([wait]));
    assert.equal(
      document.querySelector(".turn-running-label")?.getAttribute("data-phase"),
      "waiting",
    );
    assert.equal(
      document
        .querySelector(".turn-running-label .activity-text")
        ?.getAttribute("data-active"),
      "false",
    );
    await h.render(
      runtimeThread([wait, runtimeTask("other", "task-b", "running")]),
    );
    assert.equal(
      document.querySelector(".turn-running-label")?.getAttribute("data-phase"),
      "running",
    );
    assert.equal(
      document
        .querySelector(".turn-running-label .activity-text")
        ?.getAttribute("data-active"),
      "false",
    );
    assert.equal(
      document
        .querySelector(".turn-running-label")
        ?.getAttribute("data-compact"),
      "true",
    );
    assert.equal(
      document
        .querySelector(".trace-toggle .activity-text")
        ?.getAttribute("data-active"),
      "true",
    );
  });
});

test("empty recovered turn without start evidence does not advertise running animation", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread([]);
    thread.turns[0]!.startedAt = null;
    await h.render(thread);
    assert.equal(
      document
        .querySelector(".turn-running-label .activity-text")
        ?.getAttribute("data-active"),
      "false",
    );
  });
});

test("action-set headers keep one mounted disclosure and metadata while current work changes", async () => {
  await withRuntimeDom(async (h) => {
    const first = runtimeTask("first", "task-one", "running");
    const second = {
      ...runtimeCommand("second", "browser_inspect"),
      toolName: "browser_inspect",
    };
    await h.render(runtimeThread([first, second]));
    const toggle = document.querySelector<HTMLButtonElement>(".trace-toggle")!;
    const metadata = document.querySelector(".turn-running-label")!;
    const title = document.querySelector(".trace-activity-title")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(metadata.getAttribute("data-compact"), "true");
    assert.ok(metadata.querySelector('[role="status"].sr-only'));
    assert.ok(metadata.querySelector(".turn-duration"));
    assert.equal(toggle.querySelector(".trace-counts")?.textContent, "");
    await h.click(".trace-toggle");
    await h.render(
      runtimeThread([runtimeTask("first", "task-one", "completed"), second]),
    );
    assert.equal(document.querySelector(".trace-toggle"), toggle);
    assert.equal(document.querySelector(".trace-activity-title"), title);
    assert.equal(document.querySelector(".turn-running-label"), metadata);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(title.textContent, "Run command ×1 · Inspect page ×1");
    assert.equal(title.getAttribute("title"), title.textContent);
    assert.equal(
      title.querySelector(".activity-text")?.getAttribute("data-active"),
      "false",
    );
    assert.equal(
      metadata.getAttribute("data-compact"),
      "false",
      "model-only continuation retains its honest status",
    );
  });
});

test("waiting and approval retain visible static metadata rather than duplicate activity", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread([runtimeWait("wait", "waiting"), runtimeCommand("done")]),
    );
    const label = document.querySelector(".turn-running-label")!;
    assert.equal(label.getAttribute("data-compact"), "false");
    assert.equal(label.querySelector(".sr-only"), null);
    assert.equal(
      document
        .querySelector(".trace-toggle .activity-text")
        ?.getAttribute("data-active"),
      "false",
    );
    assert.equal(
      document.querySelector(".trace-activity-title")?.textContent,
      "Waiting for task",
    );
    await h.render(
      runtimeThread([
        runtimeCommand("approval-call", "run_code", "inProgress"),
      ]),
      { approvals: [runtimeApproval] },
    );
    assert.equal(label.getAttribute("data-phase"), "approval");
    assert.equal(label.getAttribute("data-compact"), "false");
    assert.equal(
      label.querySelector(".activity-text")?.getAttribute("data-active"),
      "false",
    );
  });
});

test("submitted generic call is requested and static until an authoritative running receipt", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread([runtimeCommand("raw", "npm test", "inProgress")]),
    );
    assert.equal(
      document.querySelector(".turn-running-label")?.getAttribute("data-phase"),
      "requested",
    );
    assert.equal(
      document
        .querySelector(".turn-running-label .activity-text")
        ?.getAttribute("data-active"),
      "false",
    );
  });
});

test("whole-turn terminal proof retires a separated prior singleton", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread([
        runtimeTask("launch", "same", "running"),
        runtimeMessage("partial", "Confirmed source result."),
        runtimeTask("settled", "same", "cancelled"),
      ]),
    );
    const old = document.querySelector(".trace-singleton")!;
    assert.equal(old.getAttribute("data-unsettled"), "false");
    assert.equal(old.querySelector('[data-active="true"]'), null);
  });
});

test("manual trace collapse survives count updates and promotion preserves disclosure identity", async () => {
  await withRuntimeDom(async (h) => {
    const first = runtimeTask("first", "a", "running");
    await h.render(runtimeThread([first]));
    await h.click(".trace-item-toggle");
    const initial = document.querySelector(".trace-singleton");
    await h.render(
      runtimeThread([first, runtimeTask("second", "b", "running")]),
    );
    assert.ok(document.querySelector(".trace-group") === initial);
    assert.equal(
      document.querySelector(".trace-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
    await h.click(".trace-toggle");
    await h.render(
      runtimeThread([
        first,
        runtimeTask("second", "b", "completed"),
        runtimeTask("third", "c", "running"),
      ]),
    );
    assert.equal(
      document.querySelector(".trace-toggle")?.getAttribute("aria-expanded"),
      "false",
    );
  });
});

test("only exact item-correlated request replaces a row phase with Approval required", async () => {
  await withRuntimeDom(async (h) => {
    const matching = runtimeCommand(
      "approval-call",
      "write file",
      "inProgress",
    );
    await h.render(
      runtimeThread([matching, runtimeTask("other", "b", "running")]),
      { approvals: [runtimeApproval] },
    );
    await h.click(".trace-toggle");
    const rows = [...document.querySelectorAll(".trace-items .trace-item")];
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent!, /Approval required/u);
    assert.doesNotMatch(rows[1]!.textContent!, /Approval required/u);
    assert.match(rows[1]!.textContent!, /Running/u);
  });
});

test("stop acknowledgement stays pending until canonical terminal evidence", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread([runtimeTask("running", "task", "running")]);
    let calls = 0;
    const props = {
      composer: emptyComposerState(),
      onInterrupt: async () => {
        calls++;
      },
    };
    await h.render(thread, props);
    await h.click('[aria-label="Stop"]');
    assert.equal(calls, 1);
    assert.equal(
      document.querySelector(".turn-running-label")?.getAttribute("data-phase"),
      "stopping",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>('[aria-label="Stopping…"]')
        ?.disabled,
      true,
    );
    await h.render(
      confirmedStopped([runtimeTask("settled", "task", "cancelled")]),
      props,
    );
    assert.equal(document.querySelector(".turn-running-label"), null);
    assert.match(
      document.querySelector(".turn-outcome")!.textContent!,
      /Stopped/u,
    );
  });
});

test("older Stop rejection cannot clear a newer same-thread request after navigation", async () => {
  await withRuntimeDom(async (h) => {
    const a = runtimeThread([runtimeTask("running", "task", "running")]);
    const b = { ...a, id: "thread-b" };
    let rejectFirst!: (e: Error) => void,
      calls = 0;
    const props = {
      composer: emptyComposerState(),
      onInterrupt: () => {
        calls++;
        return new Promise<void>((_, reject) => {
          if (calls === 1) rejectFirst = reject;
        });
      },
    };
    await h.render(a, props);
    await h.click('[aria-label="Stop"]');
    await h.render(b, props);
    await h.render(a, props);
    await h.click('[aria-label="Stop"]');
    await act(async () => rejectFirst(new Error("Old request disconnected")));
    assert.equal(calls, 2);
    assert.equal(
      document.querySelector(".turn-running-label")?.getAttribute("data-phase"),
      "stopping",
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /Old request disconnected/u,
    );
  });
});

for (const release of [false, true])
  test(`terminal ${release ? "folds after selection is released to Composer" : "preserves selected tool output"}`, async () => {
    await withRuntimeDom(async (h) => {
      const items = [runtimeCommand("one"), runtimeCommand("two")];
      await h.render(runtimeThread(items));
      await h.click(".trace-toggle");
      await h.click(".trace-items .trace-item-toggle");
      const detail = document.querySelector(".trace-detail")!;
      assert.ok(detail);
      await act(async () => {
        const range = document.createRange();
        range.selectNodeContents(detail);
        document.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      if (release)
        await act(async () => {
          document.getSelection()!.removeAllRanges();
          document.querySelector("textarea")!.focus();
          document.dispatchEvent(new Event("selectionchange"));
        });
      await h.render(
        runtimeThread(
          [...items, runtimeMessage("answer", "Completed answer.")],
          "completed",
        ),
      );
      assert.equal(
        document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
        String(!release),
      );
      if (!release) assert.ok(detail.isConnected);
    });
  });

test("interrupted partial answer and unconfirmed task remain readable; review opens pending activity", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread(
        [
          runtimeMessage(
            "partial",
            "Validated the first two files. The remaining check did not settle.",
          ),
          runtimeTask("cancel", "task", "cancellation_unconfirmed", "declined"),
          runtimeCommand("other"),
        ],
        "interrupted",
      ),
    );
    assert.match(document.body.textContent!, /Validated the first two files/u);
    assert.match(
      document.querySelector(".turn-outcome")!.textContent!,
      /not confirm/u,
    );
    assert.equal(
      document.querySelector(".trace-toggle")?.getAttribute("aria-expanded"),
      "false",
    );
    await h.click(".turn-outcome button");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(
      document.querySelector(".trace-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
  });
});

test("failed turn preserves provider error alongside an unconfirmed external action warning", async () => {
  await withRuntimeDom(async (h) => {
    const thread = runtimeThread(
      [
        runtimeTask(
          "uncertain",
          "task",
          "cancellation_unconfirmed",
          "declined",
        ),
      ],
      "failed",
    );
    thread.turns[0]!.error = {
      message: "Provider disconnected during response",
      codexErrorInfo: null,
      additionalDetails: null,
    };
    await h.render(thread);
    assert.match(
      document.body.textContent!,
      /Provider disconnected during response/u,
    );
    assert.match(
      document.querySelector(".turn-outcome")!.textContent!,
      /not confirm/u,
    );
  });
});

test("transcript selection pauses live following; explicit Back to live clears it", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(
      runtimeThread([
        runtimeMessage("read", "Read this existing partial result."),
        runtimeTask("run", "task", "running"),
      ]),
    );
    const scroll = document.querySelector<HTMLElement>(".messages")!;
    let height = 1000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => height },
    });
    scroll.scrollTop = 600;
    await act(async () => scroll.dispatchEvent(new window.Event("scroll")));
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(
        document.querySelector(".turn-history article p")!,
      );
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    assert.equal(
      document.querySelector(".back-live"),
      null,
      "selection at the floor has no hidden content to return to",
    );
    await act(async () => {
      height = 1400;
      scroll.dispatchEvent(new window.Event("scroll"));
    });
    assert.equal(
      scroll.scrollTop,
      600,
      "selection pauses follow as content grows",
    );
    assert.ok(document.querySelector(".back-live"));
    // JSDOM has no scrolling primitive; this verifies the actual handler and selection semantics.
    scroll.scrollTo = () => {
      scroll.scrollTop = height - 400;
    };
    await h.click(".back-live");
    assert.equal(document.getSelection()!.isCollapsed, true);
    assert.equal(scroll.scrollTop, 1000);
    assert.ok(!document.querySelector(".back-live"));
  });
});

test("terminal commit observes an existing selection even before queued selectionchange fires", async () => {
  await withRuntimeDom(async (h) => {
    const items = [runtimeCommand("one"), runtimeCommand("two")];
    await h.render(runtimeThread(items));
    await h.click(".trace-toggle");
    await h.click(".trace-items .trace-item-toggle");
    const detail = document.querySelector(".trace-detail")!;
    const range = document.createRange();
    range.selectNodeContents(detail);
    document.getSelection()!.addRange(range);
    const selected = document.getSelection()!.toString();
    await h.render(
      runtimeThread(
        [...items, runtimeMessage("answer", "Finished answer.")],
        "completed",
      ),
    );
    assert.ok(
      detail.isConnected,
      "selected detail must survive terminal commit",
    );
    assert.equal(document.getSelection()!.toString(), selected);
    assert.equal(
      document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
  });
});

test("inspection retained through completion stays operable when reader moves to trace controls", async () => {
  await withRuntimeDom(async (h) => {
    const items = [runtimeCommand("one"), runtimeCommand("two")];
    await h.render(runtimeThread(items));
    await h.click(".trace-toggle");
    await h.click(".trace-items .trace-item-toggle");
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".trace-detail")!);
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await h.render(
      runtimeThread(
        [...items, runtimeMessage("answer", "Finished answer.")],
        "completed",
      ),
    );
    await act(async () => {
      document.getSelection()!.removeAllRanges();
      document.querySelector<HTMLButtonElement>(".trace-toggle")!.focus();
      document.dispatchEvent(new Event("selectionchange"));
    });
    assert.equal(
      document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
    assert.ok(
      document.querySelector(".trace-toggle")?.contains(document.activeElement),
    );
  });
});

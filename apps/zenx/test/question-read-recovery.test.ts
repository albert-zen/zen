import "./dom-primitives.js";
import "../src/renderer/src/i18n.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useQuestionReadRecovery } from "../src/renderer/src/use-question-read-recovery.js";

test("question list recovery retries twice, resets only on success, and retires old owners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const reads: string[] = [];
  function Harness({
    owner = "a",
    loading = false,
    error = "offline",
    disabled = false,
  }: {
    owner?: string;
    loading?: boolean;
    error?: string;
    disabled?: boolean;
  }) {
    useQuestionReadRecovery({
      owner,
      loading,
      error,
      disabled,
      refresh: async () => {
        reads.push(owner);
      },
    });
    return null;
  }
  const render = async (props: React.ComponentProps<typeof Harness> = {}) =>
    act(async () => root.render(React.createElement(Harness, props)));
  const tick = async (ms: number) =>
    act(async () => {
      t.mock.timers.tick(ms);
    });
  try {
    await render();
    await tick(999);
    assert.equal(reads.length, 0);
    await tick(1);
    assert.deepEqual(reads, ["a"]);
    await render({ loading: true });
    await render();
    await tick(2999);
    assert.equal(reads.length, 1);
    await tick(1);
    assert.equal(reads.length, 2);
    await render({ loading: true });
    await render();
    await tick(60000);
    assert.equal(reads.length, 2, "persistent failures never loop");
    await render({ error: "" });
    await render();
    await tick(1000);
    assert.equal(
      reads.length,
      3,
      "a successful read resets the bounded episode",
    );
    await render({ owner: "b" });
    await render({ owner: "c", disabled: true });
    await tick(60000);
    assert.equal(
      reads.length,
      3,
      "navigation and disabling cancel pending retries",
    );
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.equal(reads.length, 3);
    await render({ owner: "c", error: "" });
    await act(async () => window.dispatchEvent(new window.Event("online")));
    assert.equal(reads.at(-1), "c");
    await render({ owner: "c", loading: true });
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.equal(
      reads.length,
      4,
      "in-flight reads are not duplicated by focus",
    );
    await render({ owner: "c" });
    await act(async () => root.unmount());
    await tick(60000);
    window.dispatchEvent(new window.Event("online"));
    assert.equal(reads.length, 4, "unmount retires timers and listeners");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
    t.mock.timers.reset();
  }
});

for (const kind of ["native", "room"] as const) {
  test(`${kind} question view recovers list errors without a refresh toolbar or answer writes`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
    };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    let reads = 0,
      writes = 0;
    let changed: ((id: string) => void) | undefined;
    let ready: ((status: { type: string }) => void) | undefined;
    const specification = {
      questions: [{ id: "q", prompt: "Synthetic question" }],
      answerTemplate: "{{q}}",
    };
    const list = async () => {
      if (++reads <= 2) throw new Error("Synthetic temporary list outage");
      return kind === "native"
        ? {
            questions: [
              {
                request: { threadId: "t", callItemId: "call" },
                resultItemId: "result",
                createdAt: "2026-11-05T00:00:00Z",
                state: "open",
                specification,
              },
            ],
            totalPending: 1,
          }
        : {
            roomId: "r",
            questions: [
              {
                roomId: "r",
                id: "q",
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                origin: { threadId: "t", callItemId: "call" },
                state: "open",
                specification,
              },
            ],
            revision: 1,
            openCount: 1,
            totalQuestions: 1,
          };
    };
    Object.assign(window, {
      zenx: {
        roomQuestions: {
          request: async (params: { method: string }) => {
            if (params.method === "list") return list();
            writes++;
            throw Error("Unexpected write");
          },
          onChanged: (callback: typeof changed) => {
            changed = callback;
            return () => {
              changed = undefined;
            };
          },
        },
        protocol: {
          onStatus: (callback: typeof ready) => {
            ready = callback;
            return () => {
              ready = undefined;
            };
          },
        },
      },
    });
    const root = createRoot(document.getElementById("root")!);
    try {
      let element: React.ReactElement;
      if (kind === "native") {
        const { UserQuestionCards } =
          await import("../src/renderer/src/UserQuestionCards.js");
        const { createUserQuestionStore } =
          await import("../src/renderer/src/user-question-state.js");
        const store = createUserQuestionStore({
          list: list as import("../src/renderer/src/user-question-state.js").QuestionTransport["list"],
          read: async () => {
            throw Error("Unexpected readback");
          },
          respond: async () => {
            writes++;
            throw Error("Unexpected write");
          },
        });
        element = React.createElement(UserQuestionCards, {
          threadId: "t",
          store,
        });
      } else {
        const { RoomQuestionCards } =
          await import("../src/renderer/src/RoomQuestionCards.js");
        element = React.createElement(RoomQuestionCards, {
          roomId: "r",
          members: [],
          threads: [],
        });
      }
      await act(async () => root.render(element));
      assert.equal(reads, 1);
      assert.equal(document.querySelectorAll("header button").length, 0);
      assert.ok(
        document.querySelector(".user-question-error button")?.textContent,
      );
      await act(async () => {
        t.mock.timers.tick(1000);
      });
      assert.equal(reads, 2);
      await act(async () => {
        t.mock.timers.tick(3000);
      });
      assert.equal(reads, 3);
      assert.equal(document.querySelector(".user-question-error"), null);
      const input = document.querySelector("textarea")!;
      const key = Object.keys(input).find((k) =>
        k.startsWith("__reactProps$"),
      )!;
      await act(async () =>
        (
          input as unknown as Record<
            string,
            { onChange: (event: unknown) => void }
          >
        )[key]!.onChange({ target: { value: "Retain my draft" } }),
      );
      if (kind === "room") {
        await act(async () => changed?.("r"));
        await act(async () => ready?.({ type: "ready" }));
        assert.equal(
          reads,
          5,
          "Room changes and reconnection re-read automatically",
        );
      } else {
        await act(async () => window.dispatchEvent(new window.Event("focus")));
        assert.equal(reads, 4);
      }
      assert.equal(
        document.querySelector("textarea")!.value,
        "Retain my draft",
      );
      assert.equal(writes, 0);
      await act(async () => root.unmount());
      assert.equal(changed, undefined);
      assert.equal(ready, undefined);
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
      t.mock.timers.reset();
    }
  });
}

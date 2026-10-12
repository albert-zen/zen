import assert from "node:assert/strict";
import test from "node:test";
import {
  act,
  withRuntimeDom as withUnkeyedRuntimeDom,
} from "./agent-runtime-dom.js";

// Existing runtime tests also exercise updates within one mounted ThreadView.
// These navigation regressions deliberately mirror App's keyed thread remounts.
const withRuntimeDom: typeof withUnkeyedRuntimeDom = (run) =>
  withUnkeyedRuntimeDom(run, { keyByThread: true });
import {
  runtimeThread,
  runtimeCommand,
} from "./fixtures/agent-runtime-data.js";

const expanded = (selector: string) =>
  document.querySelector(selector)?.getAttribute("aria-expanded");

test("explicit turn, trace and tool choices survive a thread round trip", async () => {
  await withRuntimeDom(async (h) => {
    const a = runtimeThread(
      [runtimeCommand("one"), runtimeCommand("two")],
      "completed",
    );
    const b = {
      ...a,
      id: "thread-b",
      turns: [{ ...a.turns[0]!, id: "turn-b" }],
    };
    await h.render(a);
    await h.click(".turn-toggle");
    await h.click(".trace-toggle");
    await h.click(".trace-item-toggle");
    await h.render(b);
    assert.equal(expanded(".turn-toggle"), "false");
    await h.render(a);
    assert.equal(expanded(".turn-toggle"), "true");
    assert.equal(expanded(".trace-toggle"), "true");
    assert.equal(expanded(".trace-item-toggle"), "true");
  });
});

test("same Turn and Item IDs in another thread cannot inherit explicit choices", async () => {
  await withRuntimeDom(async (h) => {
    const a = runtimeThread(
      [runtimeCommand("one"), runtimeCommand("two")],
      "completed",
    );
    const b = { ...a, id: "thread-b" };
    await h.render(a);
    await h.click(".turn-toggle");
    await h.click(".trace-toggle");
    await h.click(".trace-item-toggle");
    await h.render(b);
    assert.equal(expanded(".turn-toggle"), "false");
    await h.click(".turn-toggle");
    assert.equal(expanded(".trace-toggle"), "false");
    await h.click(".trace-toggle");
    assert.equal(expanded(".trace-item-toggle"), "false");
    await h.render(a);
    assert.equal(expanded(".trace-item-toggle"), "true");
    await h.click(".trace-item-toggle");
    await h.click(".trace-toggle");
    await h.hide();
    await h.render(a);
    assert.equal(expanded(".turn-toggle"), "true");
    assert.equal(expanded(".trace-toggle"), "false");
    await h.click(".trace-toggle");
    assert.equal(expanded(".trace-item-toggle"), "false");
    await h.click(".turn-toggle");
    await h.hide();
    await h.render(a);
    assert.equal(expanded(".turn-toggle"), "false");
  });
});

test("repeated item IDs in different turns retain independent choices and promotion survives remount", async () => {
  await withRuntimeDom(async (h) => {
    const first = runtimeCommand("shared");
    const a = runtimeThread([first]);
    await h.render(a);
    await h.click(".trace-item-toggle");
    await h.hide();
    await h.render(runtimeThread([first, runtimeCommand("second")]));
    assert.equal(expanded(".trace-toggle"), "true");
    assert.equal(expanded(".trace-item-toggle"), "true");
    const later = { ...a, turns: [{ ...a.turns[0]!, id: "another-turn" }] };
    await h.render(later);
    assert.equal(expanded(".trace-item-toggle"), "false");
    await h.render(a);
    assert.equal(expanded(".trace-item-toggle"), "true");
  });
});

// Real DOM handlers with deterministic layout; browser replay covers native geometry.
async function withScrollLayout(run: (resize: () => void) => Promise<void>) {
  const previous = globalThis.ResizeObserver;
  const callbacks = new Set<() => void>();
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe() {
      callbacks.add(this.callback);
    }
    disconnect() {
      callbacks.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  try {
    await run(() => {
      for (const callback of callbacks) callback();
    });
  } finally {
    globalThis.ResizeObserver = previous;
  }
}
function layoutScroll() {
  const element = document.querySelector<HTMLElement>(".messages")!;
  let height = 1000,
    top = 600;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(height - 400, value));
      },
    },
  });
  element.scrollTo = (options) => {
    if (typeof options === "object") element.scrollTop = options.top ?? top;
  };
  return {
    element,
    grow: () => {
      height += 400;
    },
  };
}

test("idle upward wheel within the old 80px threshold stays paused through resize and refresh", async () => {
  await withRuntimeDom(async (h) => {
    await withScrollLayout(async (resize) => {
      const value = runtimeThread([runtimeCommand("done")], "completed");
      await h.render(value);
      const { element, grow } = layoutScroll();
      await act(async () => {
        element.dispatchEvent(
          new window.WheelEvent("wheel", { deltaY: -40, bubbles: true }),
        );
        element.scrollTop = 560;
        element.dispatchEvent(new window.Event("scroll"));
      });
      assert.ok(
        document.querySelector(".back-live"),
        "near-bottom scroll must not re-arm following",
      );
      await act(async () => {
        grow();
        resize();
      });
      assert.equal(
        element.scrollTop,
        560,
        "idle layout cannot snap the reader to bottom",
      );
      await h.render({ ...value, turns: [...value.turns] });
      assert.equal(
        element.scrollTop,
        560,
        "equivalent snapshot cannot steal manual position",
      );
      await h.click(".back-live");
      assert.equal(element.scrollTop, 1000);
    });
  });
});

test("idle content resizing alone never follows the bottom", async () => {
  await withRuntimeDom(async (h) => {
    await withScrollLayout(async (resize) => {
      await h.render(runtimeThread([runtimeCommand("done")], "completed"));
      const { element, grow } = layoutScroll();
      await act(async () => {
        grow();
        resize();
      });
      assert.equal(element.scrollTop, 600);
      assert.ok(document.querySelector(".back-live"));
    });
  });
});

test("thread reading position and paused intent survive viewport unmounts independently", async () => {
  await withRuntimeDom(async (h) => {
    const tops = new WeakMap<HTMLElement, number>();
    Object.defineProperties(window.HTMLElement.prototype, {
      clientHeight: {
        configurable: true,
        get() {
          return this.classList.contains("messages") ? 400 : 0;
        },
      },
      scrollHeight: {
        configurable: true,
        get() {
          return this.classList.contains("messages") ? 1000 : 0;
        },
      },
      scrollTop: {
        configurable: true,
        get() {
          return tops.get(this) ?? 0;
        },
        set(value: number) {
          tops.set(this, Math.max(0, Math.min(600, value)));
        },
      },
    });
    const a = runtimeThread([runtimeCommand("done")], "completed");
    const b = { ...a, id: "thread-b" };
    const scroll = () => document.querySelector<HTMLElement>(".messages")!;
    const readAt = async (top: number) =>
      act(async () => {
        scroll().scrollTop = top;
        scroll().dispatchEvent(new window.Event("scroll"));
      });
    await h.render(a);
    assert.equal(scroll().scrollTop, 600);
    await readAt(560);
    await h.hide();
    await h.render(a);
    assert.equal(scroll().scrollTop, 560);
    assert.ok(document.querySelector(".back-live"));
    await h.render(b);
    assert.equal(scroll().scrollTop, 600, "a new thread starts live");
    assert.equal(document.querySelector(".back-live"), null);
    await readAt(200);
    await h.render(a);
    assert.equal(scroll().scrollTop, 560);
    await h.render(b);
    assert.equal(scroll().scrollTop, 200);
  });
});

test("live streamed growth still follows until a keyboard reader pauses it", async () => {
  await withRuntimeDom(async (h) => {
    await withScrollLayout(async (resize) => {
      await h.render(
        runtimeThread([runtimeCommand("running", "long call", "inProgress")]),
      );
      const { element, grow } = layoutScroll();
      await act(async () => {
        grow();
        resize();
      });
      assert.equal(element.scrollTop, 1000);
      await act(async () => {
        element.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
        );
        element.scrollTop = 960;
        element.dispatchEvent(new window.Event("scroll"));
        grow();
        resize();
      });
      assert.equal(element.scrollTop, 960);
      assert.ok(document.querySelector(".back-live"));
      await act(async () => {
        element.scrollTop = 1400;
        element.dispatchEvent(new window.Event("scroll"));
      });
      assert.ok(
        document.querySelector(".back-live"),
        "manual arrival at bottom cannot silently re-arm following",
      );
      await h.click(".back-live");
      await act(async () => {
        grow();
        resize();
      });
      assert.equal(element.scrollTop, 1800);
    });
  });
});

test("idle resize pauses following even through equivalent snapshot rerenders", async () => {
  await withRuntimeDom(async (h) => {
    await withScrollLayout(async (resize) => {
      const value = runtimeThread([runtimeCommand("done")], "completed");
      await h.render(value);
      const { element, grow } = layoutScroll();
      // A layout render can arrive before ResizeObserver delivers its callback.
      grow();
      await h.render({ ...value, turns: structuredClone(value.turns) });
      assert.equal(
        element.scrollTop,
        600,
        "fresh array identity is not a new message",
      );
      await act(async () => resize());
      assert.equal(element.scrollTop, 600);
      assert.ok(document.querySelector(".back-live"));
    });
  });
});

for (const zoneHeight of [126, 226]) {
  test(`restores a paused near-bottom reader after the ${zoneHeight}px Composer inset is published`, async () => {
    await withRuntimeDom(async (h) => {
      await withScrollLayout(async (resize) => {
        let measuredHeight = zoneHeight;
        const tops = new WeakMap<HTMLElement, number>();
        const prototype = window.HTMLElement.prototype;
        const originalRect = prototype.getBoundingClientRect;
        prototype.getBoundingClientRect = function () {
          return this.classList.contains("bottom-zone")
            ? { ...originalRect.call(this), height: measuredHeight }
            : originalRect.call(this);
        };
        Object.defineProperties(prototype, {
          clientHeight: { configurable: true, get: () => 400 },
          scrollHeight: {
            configurable: true,
            get() {
              const inset =
                Number.parseFloat(
                  this.closest(".thread-view")?.style.getPropertyValue(
                    "--bottom-zone-height",
                  ) ?? "0",
                ) || 0;
              // Match the real CSS fallback: mount starts with 38px padding,
              // then Composer geometry reserves its height plus 24px.
              return 1287 + Math.max(0, inset + 24 - 38);
            },
          },
          scrollTop: {
            configurable: true,
            get() {
              return tops.get(this) ?? 0;
            },
            set(value: number) {
              tops.set(
                this,
                Math.max(0, Math.min(this.scrollHeight - 400, value)),
              );
            },
          },
        });
        const a = runtimeThread([runtimeCommand("done")], "completed");
        const b = { ...a, id: "thread-b" };
        const scroll = () => document.querySelector<HTMLElement>(".messages")!;
        const readAt = async (top: number) =>
          act(async () => {
            scroll().dispatchEvent(
              new window.WheelEvent("wheel", { deltaY: -75, bubbles: true }),
            );
            scroll().scrollTop = top;
            scroll().dispatchEvent(new window.Event("scroll"));
          });
        await h.render(a);
        const savedTop = 924 + zoneHeight - 126;
        await readAt(savedTop);
        await h.render(b);
        await h.render(a);
        assert.equal(
          scroll().scrollTop,
          savedTop,
          "thread round trip must not retain the temporary clamp",
        );
        await h.hide();
        await h.render(a);
        assert.equal(
          scroll().scrollTop,
          savedTop,
          "Settings remount must preserve a tall-draft reading position",
        );
        // There is no delayed restore left to fight later user input or resize.
        await readAt(850);
        await act(async () => {
          measuredHeight += 80;
          resize();
        });
        assert.equal(scroll().scrollTop, 850);
        await h.hide();
        await h.render(a);
        assert.equal(
          scroll().scrollTop,
          850,
          "new manual intent replaces the restored target",
        );
      });
    });
  });
}

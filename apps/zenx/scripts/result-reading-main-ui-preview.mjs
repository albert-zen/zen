import assert from "node:assert/strict";

/** Record facts, not a presumed alignment/overflow defect. */
export function observeResultReading() {
  const wrap = document.querySelector(".agent-copy .markdown-table-wrap");
  const table = wrap?.querySelector("table");
  const messages = document.querySelector(".messages");
  const composer = document.querySelector(".composer");
  if (!table || !messages || !composer) return null;
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const rows = [...table.querySelectorAll("tbody tr")].map((row) => {
    const cells = [...row.cells].map((cell) => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode()) && !text.textContent.trim()) {}
      let firstTextTop = null;
      if (text) {
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(1, text.length));
        firstTextTop = range.getBoundingClientRect().top;
      }
      return {
        text: cell.textContent,
        rect: rect(cell),
        firstTextTop,
        verticalAlign: getComputedStyle(cell).verticalAlign,
        lineHeight: getComputedStyle(cell).lineHeight,
      };
    });
    const tops = cells.map((c) => c.firstTextTop).filter(Number.isFinite);
    return {
      rect: rect(row),
      cells,
      firstTextTopSpread: Math.max(...tops) - Math.min(...tops),
    };
  });
  const dock = document.querySelector(".information-dock");
  const dockRect = dock ? rect(dock) : null;
  return {
    dock: dockRect,
    dockVisible:
      !!dock &&
      !dock.hidden &&
      getComputedStyle(dock).visibility !== "hidden" &&
      dockRect.width > 0 &&
      dockRect.height > 0,
    rows,
    table: rect(table),
    wrap: rect(wrap),
    scrollLeft: wrap.scrollLeft,
    scrollWidth: wrap.scrollWidth,
    clientWidth: wrap.clientWidth,
    overflowX: getComputedStyle(wrap).overflowX,
    messages: rect(messages),
    messageOverflow: messages.scrollWidth - messages.clientWidth,
    composer: rect(composer),
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    viewport: { width: innerWidth, height: innerHeight },
    dockOpen:
      document
        .querySelector(".information-toolbar button")
        ?.getAttribute("aria-expanded") === "true",
    proseLineHeight: getComputedStyle(table.closest(".agent-copy")).lineHeight,
  };
}

export function verifyResultReading(state, dockOpen) {
  assert(state, "Production result table exists");
  assert.equal(state.rows.length, 8, "All synthetic result rows present");
  assert(
    state.rows.every((r) => r.cells.length === 4),
    "Four semantic table columns retained",
  );
  assert(
    state.rows.every((r) =>
      r.cells.every((c) => Number.isFinite(c.firstTextTop)),
    ),
    "Every cell has measurable real text",
  );
  assert.equal(state.dockOpen, dockOpen);
  assert.equal(
    state.dockVisible,
    dockOpen,
    "Actual information dock visibility matches toggle",
  );
  assert.equal(state.proseLineHeight, "27px", "Do not compress body leading");
  assert(
    state.composer.bottom <= state.viewport.height + 1,
    "Composer stays in viewport",
  );
  // Overflow and text-top spreads are recorded for review, not suppressed by assertions.
}

export function verifyLastResultRow(state) {
  const last = state.rows.at(-1).rect;
  assert(
    last.height > 0 &&
      last.y >= state.messages.y &&
      last.bottom <= Math.min(state.messages.bottom, state.composer.y),
    "Last result row fully visible inside transcript above composer",
  );
}

export async function captureResultReading({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
  scroll,
}) {
  const target = new URL(url);
  target.searchParams.delete("codeWrap");
  target.searchParams.set("results", "1");
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href===${JSON.stringify(target.href)} && !!document.querySelector('.thread-row')`,
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait("!!document.querySelector('.agent-copy .markdown-table-wrap')");
  const observe = () => evaluate(`(${observeResultReading.toString()})()`);
  const save = async (step, open) => {
    await new Promise((r) => setTimeout(r, 150));
    const state = await observe();
    verifyResultReading(state, open);
    (evidence.resultReadingCases ??= []).push({
      theme: options.theme,
      step,
      ...state,
    });
    await capture(
      `reading-${options.name}-results-${step}`,
      options,
      "reading",
    );
    return state;
  };
  for (const open of [false, true]) {
    const current = await observe();
    if (current.dockOpen !== open) {
      await click(".information-toolbar button");
      await wait(
        `document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')===${JSON.stringify(String(open))}`,
      );
    }
    await wait(
      `(() => { const e=document.querySelector('.information-dock'),r=e?.getBoundingClientRect();return (!!e && !e.hidden && getComputedStyle(e).visibility!=='hidden' && r.width>0 && r.height>0)===${open}; })()`,
    );
    await scroll(".agent-copy .markdown-table-wrap");
    let state = await save(open ? "dock-open" : "dock-closed", open);
    if (state.scrollWidth > state.clientWidth + 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: state.wrap.x + 40,
        y: state.wrap.y + 40,
        deltaX: state.scrollWidth,
        deltaY: 0,
      });
      await wait(
        "document.querySelector('.markdown-table-wrap').scrollLeft > 0",
      );
      state = await save(
        open ? "dock-open-last-columns" : "dock-closed-last-columns",
        open,
      );
      assert(
        state.scrollLeft + state.clientWidth >= state.scrollWidth - 2,
        "Native horizontal wheel reaches last column",
      );
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: state.wrap.x + 40,
        y: state.wrap.y + 40,
        deltaX: -state.scrollWidth,
        deltaY: 0,
      });
    }
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await observe();
    const last = state.rows.at(-1).rect;
    if (
      last.bottom <= Math.min(state.composer.y, state.messages.bottom) - 12 &&
      last.y >= state.messages.y
    )
      break;
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: state.messages.x + 40,
      y: state.messages.y + 50,
      deltaX: 0,
      deltaY:
        last.y < state.messages.y
          ? last.y - state.messages.y - 12
          : Math.max(
              40,
              last.bottom -
                Math.min(state.composer.y, state.messages.bottom) +
                24,
            ),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const final = await save("last-row", true);
  verifyLastResultRow(final);
}

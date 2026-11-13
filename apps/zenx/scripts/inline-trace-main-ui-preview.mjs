import assert from "node:assert/strict";

export function observeInlineTrace() {
  const exposed = (element, rect, initial) => {
    const limit = { ...initial };
    const clips = [];
    let hiddenBy = null;
    for (let e = element; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (
        e.hidden ||
        e.inert ||
        e.hasAttribute("inert") ||
        e.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        style.opacity === "0"
      )
        hiddenBy = e.className || e.tagName;
      // Unknown shaped clipping cannot be certified by a rectangular test.
      if (style.clipPath && style.clipPath !== "none") hiddenBy = "clip-path";
      const x = ["hidden", "clip", "scroll", "auto"].includes(
        style.overflowX || style.overflow,
      );
      const y = ["hidden", "clip", "scroll", "auto"].includes(
        style.overflowY || style.overflow,
      );
      const paint = /(paint|strict|content)/.test(style.contain || "");
      if (x || y || paint) {
        const r = e.getBoundingClientRect();
        const left = r.left + e.clientLeft,
          top = r.top + e.clientTop;
        const right = left + e.clientWidth,
          bottom = top + e.clientHeight;
        if (x || paint) {
          limit.left = Math.max(limit.left, left);
          limit.right = Math.min(limit.right, right);
        }
        if (y || paint) {
          limit.top = Math.max(limit.top, top);
          limit.bottom = Math.min(limit.bottom, bottom);
        }
        clips.push({
          className: e.className,
          left,
          top,
          right,
          bottom,
          x,
          y,
          paint,
        });
      }
    }
    return {
      limit,
      clips,
      hiddenBy,
      visible:
        !hiddenBy &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= limit.left &&
        rect.top >= limit.top &&
        rect.right <= limit.right &&
        rect.bottom <= limit.bottom,
    };
  };
  const visible = (e) =>
    !!e &&
    exposed(e, e.getBoundingClientRect(), {
      left: 0,
      top: 0,
      right: innerWidth,
      bottom: innerHeight,
    }).visible;
  const transcript = document
    .querySelector(".messages")
    .getBoundingClientRect();
  const composer = document.querySelector(".composer")?.getBoundingClientRect();
  const measure = (root, needle) => {
    if (!root) return { visible: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf(needle);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const rect = range.getBoundingClientRect();
      const limit = {
        left: Math.max(0, transcript.left),
        top: Math.max(0, transcript.top),
        right: Math.min(innerWidth, transcript.right),
        bottom: Math.min(
          innerHeight,
          transcript.bottom,
          composer?.top ?? innerHeight,
        ),
      };
      return {
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        },
        ...exposed(node.parentElement, rect, limit),
      };
    }
    return { visible: false };
  };
  const turns = [...document.querySelectorAll(".messages section.turn")];
  return {
    turns: turns.map((e) => ({
      label: e.getAttribute("aria-label"),
      endItemId: e.getAttribute("data-read-message-id"),
      answerItemId: e
        .querySelector(".agent-copy [data-thread-find-item-id]")
        ?.getAttribute("data-thread-find-item-id"),
      answerMarker: measure(
        e.querySelector(".agent-copy"),
        e.textContent.includes("Summary checked")
          ? "Summary checked"
          : "Label check needs attention",
      ),
      failedOutput: measure(e, "Expected reader_name, received reader_label"),
      text: e.textContent,
      answer: e.querySelector(".agent-copy")?.textContent ?? "",
      expanded: e.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
      traces: [...e.querySelectorAll(".trace-item-toggle,.trace-toggle")].map(
        (b) => ({
          text: b.textContent,
          expanded: b.getAttribute("aria-expanded"),
          visible: visible(b),
          detailVisible: visible(
            document.getElementById(b.getAttribute("aria-controls")),
          ),
          detailText:
            document.getElementById(b.getAttribute("aria-controls"))
              ?.textContent ?? "",
        }),
      ),
    })),
    dockVisible: visible(document.querySelector(".information-dock")),
    dockOpen:
      document
        .querySelector(".information-toolbar button")
        ?.getAttribute("aria-expanded") === "true",
    telemetry: structuredClone(window.__uiPolishTelemetry),
  };
}
// A growing detail panel can reveal the output line before the panel is
// fully exposed. Keep this predicate geometry-only: semantic failures are
// still asserted separately and cannot be accepted as a stable frame.
export function inlineTraceGeometryReady(state, expanded) {
  const failedTurn = state.turns[1];
  return (
    state.turns.length === 2 &&
    state.dockOpen &&
    state.dockVisible &&
    state.turns.every((t) => t.answerMarker.visible) &&
    failedTurn.failedOutput.visible === expanded &&
    (!expanded ||
      failedTurn.traces.some(
        (t) => t.expanded === "true" && t.visible && t.detailVisible,
      ))
  );
}

export function verifyInlineTrace(state, baseline, expanded) {
  assert.equal(state.turns.length, 2);
  assert(
    state.dockOpen && state.dockVisible,
    "Information remains visibly open",
  );
  assert.match(state.turns[0].answer, /Summary checked/);
  assert.match(state.turns[1].answer, /Label check needs attention/);
  assert.equal(
    state.turns[0].expanded,
    "false",
    "Earlier turn stays collapsed",
  );
  assert.equal(state.turns[1].expanded, "true");
  assert(
    state.turns.every((t) => t.answerMarker.visible),
    "Both final answer markers fully visible in transcript above Composer",
  );
  assert.equal(
    state.turns[1].failedOutput.visible,
    expanded,
    "Failure output visibility follows actual disclosure",
  );
  if (!expanded)
    assert(
      state.turns[1].traces.length === 1 &&
        state.turns[1].traces[0].expanded === "false",
    );
  if (expanded) {
    assert(
      state.turns[1].traces.some(
        (t) =>
          t.expanded === "true" &&
          t.visible &&
          t.detailVisible &&
          t.detailText.includes("Expected reader_name, received reader_label"),
      ),
    );
    assert.match(
      state.turns[1].text,
      /Expected reader_name, received reader_label/,
    );
  }
  assert.equal(state.telemetry.informationUpdates, 0);
  assert(
    !state.telemetry.protocolCalls.some((m) =>
      /zen\/(turn|thread)\/(send|create|interrupt)/.test(m),
    ),
  );
  if (baseline) {
    assert.deepEqual(
      state.turns.map((t) => t.answer),
      baseline.turns.map((t) => t.answer),
      "Final answers unchanged",
    );
    for (const key of [
      "informationUpdates",
      "machineThreadCreateCalls",
      "sideChatCreateCommandCalls",
    ])
      assert.equal(
        state.telemetry[key],
        baseline.telemetry[key],
        `No mutation: ${key}`,
      );
    assert(
      state.telemetry.protocolCalls
        .slice(baseline.telemetry.protocolCalls.length)
        .every((m) =>
          [
            "zen/thread/read",
            "zen/thread/resume",
            "zen/thread/resume-window",
            "zen/thread/questions/list",
          ].includes(m),
        ),
      "Only known read-only protocol calls may be added",
    );
  }
}
export async function captureInlineTrace({
  send,
  evaluate,
  wait,
  capture,
  evidence,
  options,
  url,
}) {
  const startedAt = Date.now();
  const target = new URL(url);
  target.searchParams.set("results", "1");
  target.searchParams.set("inlineTrace", "1");
  for (const name of [
    "pending",
    "codeWrap",
    "childQuestions",
    "emptyProjects",
    "rails",
  ])
    target.searchParams.delete(name);
  await evaluate("window.__previousInlineTraceDocument=true");
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href===${JSON.stringify(target.href)} && !window.__previousInlineTraceDocument && !!document.querySelector('.thread-row')`,
  );
  const click = async (selector) => {
    const point = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/enabled target');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(x<0||y<0||x>innerWidth||y>innerHeight||!e.contains(document.elementFromPoint(x,y)))throw Error('Target not visible/hittable');return{x,y}})()`,
    );
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait(
    "document.querySelectorAll('.messages section.turn').length === 2 && document.querySelector('.messages')?.textContent.includes('Label check needs attention')",
  );
  const observation = `(${observeInlineTrace.toString()})()`;
  const observe = () => evaluate(observation);
  let state = await observe();
  if (!state.dockOpen) await click(".information-toolbar button");
  await wait(
    "document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')==='true'",
  );
  state = await observe();
  // data-read-message-id is a last-turn terminal receipt, not an answer ID.
  // The actual final message owns data-thread-find-item-id in ThreadView.
  assert.deepEqual(
    state.turns.map((t) => t.answerItemId),
    ["result-answer-0", "result-answer-1"],
  );
  assert.match(state.turns[0].answer, /Summary checked/);
  assert.match(state.turns[1].answer, /Label check needs attention/);
  const selectors = state.turns.map(
    (t) =>
      `section.turn:has(.agent-copy [data-thread-find-item-id=${JSON.stringify(t.answerItemId)}])`,
  );
  assert.notEqual(selectors[0], selectors[1]);
  // Native wheel scrolling, no DOM scroll or synthetic button activation.
  const top = async () => {
    const r = await evaluate(
      "(()=>{const r=document.querySelector('.messages').getBoundingClientRect();return{x:r.x+40,y:r.y+40}})()",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...r,
      deltaX: 0,
      deltaY: -10000,
    });
    await wait("document.querySelector('.messages').scrollTop<2");
  };
  await top();
  for (let i = 0; i < 2; i++)
    if (state.turns[i].expanded === "true")
      await click(`${selectors[i]} .turn-toggle`);
  await wait(
    "[...document.querySelectorAll('.messages .turn-toggle')].every(e=>e.getAttribute('aria-expanded')==='false')",
  );
  await click(`${selectors[1]} .turn-toggle`);
  await wait(
    `document.querySelector(${JSON.stringify(selectors[1] + " .turn-toggle")})?.getAttribute('aria-expanded')==='true'`,
  );
  const traceSelector = selectors[1] + " .trace-item-toggle";
  await wait(`!!document.querySelector(${JSON.stringify(traceSelector)})`);
  if (
    await evaluate(
      `document.querySelector(${JSON.stringify(traceSelector)}).getAttribute('aria-expanded')==='true'`,
    )
  )
    await click(traceSelector);
  await wait(
    `document.querySelector(${JSON.stringify(traceSelector)}).getAttribute('aria-expanded')==='false'`,
  );
  const stableCapture = async (step, baseline, expanded) => {
    await wait(
      `(${inlineTraceGeometryReady.toString()})(${observation},${expanded})`,
    );
    const shape = (s) => ({
      turns: s.turns,
      dockOpen: s.dockOpen,
      dockVisible: s.dockVisible,
    });
    let prior = null;
    let stable = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const now = await observe();
      if (!inlineTraceGeometryReady(now, expanded)) {
        prior = null;
        continue;
      }
      verifyInlineTrace(now, baseline, expanded);
      if (
        prior &&
        JSON.stringify(shape(prior)) === JSON.stringify(shape(now))
      ) {
        stable = now;
        break;
      }
      prior = now;
    }
    assert(stable, "Inline disclosure geometry failed to settle");
    await capture(
      `reading-${options.name}-inline-trace-${step}`,
      options,
      "reading",
    );
    const after = await observe();
    verifyInlineTrace(after, baseline, expanded);
    assert.deepEqual(
      shape(after),
      shape(stable),
      "Screenshot-time state/geometry changed",
    );
    (evidence.inlineTraceCases ??= []).push({
      theme: options.theme,
      step,
      elapsedMs: Date.now() - startedAt,
      screenshotBefore: stable,
      screenshotAfter: after,
    });
    return after;
  };
  const baseline = await stableCapture("failed-collapsed", null, false);
  if (
    await evaluate(
      `document.querySelector(${JSON.stringify(traceSelector)}).getAttribute('aria-expanded')!=='true'`,
    )
  )
    await click(traceSelector);
  await wait(
    `document.querySelector(${JSON.stringify(selectors[1])}).textContent.includes('Expected reader_name, received reader_label')`,
  );
  await stableCapture("failed-expanded", baseline, true);
}

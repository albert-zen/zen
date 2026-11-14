import assert from "node:assert/strict";

export function observeInlineTrace(
  continuation = false,
  stream = null,
  nested = false,
) {
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
  const scroller = document.querySelector(".messages");
  const transcript = scroller.getBoundingClientRect();
  const composer = document.querySelector(".composer")?.getBoundingClientRect();
  const measure = (root, needle, hitTest = false) => {
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
      const fragments = hitTest
        ? [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
        : [];
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
        ...(hitTest
          ? {
              hit:
                fragments.length > 0 &&
                fragments.every((r) =>
                  node.parentElement.contains(
                    document.elementFromPoint(
                      r.left + r.width / 2,
                      r.top + r.height / 2,
                    ),
                  ),
                ),
            }
          : {}),
      };
    }
    return { visible: false };
  };
  const turns = [...document.querySelectorAll(".messages section.turn")];
  let continuationState;
  if (continuation) {
    const top = Math.max(0, transcript.top),
      bottom = Math.min(
        innerHeight,
        transcript.bottom,
        composer?.top ?? innerHeight,
      );
    let wheel = null;
    for (const fraction of [0.2, 0.5, 0.8]) {
      const point = {
        x: transcript.left + 8,
        y: top + (bottom - top) * fraction,
      };
      const hit = document.elementFromPoint(point.x, point.y);
      if (
        !hit ||
        !scroller.contains(hit) ||
        hit.closest(
          'button,a,input,textarea,select,[contenteditable="true"],[role="button"],.trace-output',
        )
      )
        continue;
      let owner = hit;
      while (
        owner !== scroller &&
        !/(auto|scroll)/.test(getComputedStyle(owner).overflowY)
      )
        owner = owner.parentElement;
      if (
        owner === scroller &&
        /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      ) {
        wheel = point;
        break;
      }
    }
    const editor = document.querySelector(
      '.composer textarea, .composer [contenteditable="true"]',
    );
    continuationState = {
      top: scroller.scrollTop,
      left: scroller.scrollLeft,
      maxTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      wheel,
      output: [...scroller.querySelectorAll(".trace-output")].map((e) => [
        e.scrollTop,
        e.scrollLeft,
      ]),
      page: [window.scrollX, window.scrollY],
      draft: editor?.value ?? editor?.textContent ?? null,
      composer: composer && [
        composer.x,
        composer.y,
        composer.width,
        composer.height,
      ],
    };
  }
  // Dedicated standard-desktop stream probe reuses the exact clipping/Range and wheel owner helpers.
  // Ordinary Trace receipts and behavior are unchanged when this argument is absent.
  if (stream) {
    const root = scroller.querySelector(
      `.agent-copy[data-read-message-id="${stream.itemId}"]`,
    );
    const primary = document.querySelector(
      ".composer .composer-send-control button.action-orb",
    );
    const cue = document.querySelector(
      ".composer-reading-position button.quiet-button",
    );
    const hit = (e) => {
      if (!visible(e)) return false;
      const r = e.getBoundingClientRect();
      return e.contains(
        document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
      );
    };
    return {
      ...continuationState,
      receipt: stream,
      height: scroller.scrollHeight,
      band:
        Math.min(transcript.bottom, composer?.top ?? innerHeight) -
        Math.max(0, transcript.top),
      editorPresent: !!document.querySelector(
        '.composer textarea, .composer [contenteditable="true"]',
      ),
      primary: primary?.classList.contains("stop")
        ? "stop"
        : primary?.classList.contains("send")
          ? "send"
          : null,
      primaryHit: hit(primary),
      cue: hit(cue),
      cuePresent: !!cue,
      tail: measure(root, stream.tail, true),
      itemCount: scroller.querySelectorAll(
        `.agent-copy[data-read-message-id="${stream.itemId}"]`,
      ).length,
      paragraphs: root
        ? [...root.querySelectorAll(".markdown-body h2,.markdown-body p")].map(
            (e) => e.textContent,
          )
        : [],
      telemetry: structuredClone(window.__uiPolishTelemetry),
    };
  }
  let nestedOutput;
  if (nested) {
    const outputs = turns[1]?.querySelectorAll(".trace-output") ?? [];
    const output = outputs[0];
    const r = output?.getBoundingClientRect();
    let wheel = null;
    if (r) {
      const top = Math.max(0, transcript.top, r.top + output.clientTop);
      const bottom = Math.min(
        innerHeight,
        transcript.bottom,
        composer?.top ?? innerHeight,
        r.top + output.clientTop + output.clientHeight,
      );
      for (const fraction of [0.25, 0.5, 0.75]) {
        const point = {
          x: r.left + output.clientLeft + Math.min(24, output.clientWidth / 2),
          y: top + (bottom - top) * fraction,
        };
        const hit = document.elementFromPoint(point.x, point.y);
        if (
          bottom <= top ||
          !hit ||
          !output.contains(hit) ||
          hit.closest(
            'button,a,input,textarea,select,[contenteditable="true"],[role="button"]',
          )
        )
          continue;
        let owner = hit;
        while (
          owner !== output &&
          !/(auto|scroll)/.test(getComputedStyle(owner).overflowY)
        )
          owner = owner.parentElement;
        if (
          owner === output &&
          /(auto|scroll)/.test(getComputedStyle(output).overflowY)
        ) {
          wheel = point;
          break;
        }
      }
    }
    nestedOutput = output
      ? {
          count: outputs.length,
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          top: output.scrollTop,
          left: output.scrollLeft,
          maxTop: Math.max(0, output.scrollHeight - output.clientHeight),
          clientHeight: output.clientHeight,
          clientWidth: output.clientWidth,
          scrollWidth: output.scrollWidth,
          focused: document.activeElement === output,
          role: output.getAttribute("role"),
          tabIndex: output.tabIndex,
          wheel,
          head: measure(
            output,
            "Expected reader_name, received reader_label",
            true,
          ),
          end: measure(output, "Synthetic nested output ends here.", true),
          pageHorizontalOverflow:
            document.documentElement.scrollWidth > innerWidth,
        }
      : null;
  }
  return {
    ...(nested ? { nestedOutput } : {}),
    ...(continuation ? { continuation: continuationState } : {}),
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
      ...(continuation
        ? {
            answerEnd: measure(
              e.querySelector(".agent-copy"),
              "No command was executed or retried.",
              true,
            ),
          }
        : {}),
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
export function observeInlineClick(selector, transcriptControl) {
  const el = document.querySelector(selector);
  const scroller = document.querySelector(".messages");
  const composer = document.querySelector(".composer");
  const rect = (e) => e?.getBoundingClientRect().toJSON() ?? null;
  const target = rect(el);
  const scroll = rect(scroller);
  const composerBox = rect(composer);
  const point = target && {
    x: target.left + target.width / 2,
    y: target.top + target.height / 2,
  };
  const hit = point && document.elementFromPoint(point.x, point.y);
  const available = scroll && {
    top: Math.max(0, scroll.top),
    bottom: Math.min(
      innerHeight,
      scroll.bottom,
      composerBox?.top ?? innerHeight,
    ),
  };
  const inside =
    !!point &&
    point.x >= 0 &&
    point.x < innerWidth &&
    point.y >= 0 &&
    point.y < innerHeight;
  const readable =
    !transcriptControl ||
    (!!available && point?.y >= available.top && point.y < available.bottom);
  const wheel =
    available && scroll && available.bottom - available.top > 40
      ? {
          x: scroll.left + Math.min(48, scroll.width / 2),
          y: available.top + 24,
        }
      : null;
  const layout = (e) => {
    const style = getComputedStyle(e);
    return {
      tag: e.tagName,
      className: e.getAttribute("class"),
      box: rect(e),
      transform: style.transform,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      overflowY: style.overflowY,
    };
  };
  const ancestors = [];
  for (
    let e = el?.parentElement;
    transcriptControl && e && ancestors.length < 10;
    e = e.parentElement
  ) {
    ancestors.push(layout(e));
    if (e === scroller) break;
  }
  return {
    point,
    target,
    disabled: !!el?.disabled,
    hit: hit && { tag: hit.tagName, className: hit.getAttribute("class") },
    ready: !!(
      target?.width &&
      target.height &&
      !el.disabled &&
      inside &&
      readable &&
      el.contains(hit)
    ),
    scroll: scroller && {
      box: scroll,
      top: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      maxTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      wheelOwned:
        !!wheel &&
        scroller.contains(document.elementFromPoint(wheel.x, wheel.y)),
    },
    available,
    wheel,
    composer: composerBox,
    ancestors,
    rows:
      transcriptControl && scroller
        ? [...scroller.querySelectorAll("section.turn")].slice(0, 2).map(layout)
        : [],
  };
}

export function inlineWheelDelta(state) {
  const { point, available, scroll, wheel, target, disabled } = state;
  if (
    !point ||
    !available ||
    !wheel ||
    !scroll?.wheelOwned ||
    !target?.width ||
    !target.height ||
    disabled
  )
    return 0;
  // Never scroll to work around a control that is within the reading band
  // but covered by some other element. Only bring off-band targets into view.
  if (point.y >= available.top && point.y < available.bottom) return 0;
  if (point.y < available.top && scroll.top <= 1) return 0;
  if (point.y >= available.bottom && scroll.top >= scroll.maxTop - 1) return 0;
  const towardMiddle = point.y - (available.top + available.bottom) / 2;
  return Math.round(Math.max(-360, Math.min(360, towardMiddle)));
}

export async function seekInlineClick({
  sample,
  settle,
  wheel,
  samples,
  transcriptControl,
}) {
  let previous = null;
  for (let i = 0; i < 12; i++) {
    await settle();
    const state = await sample();
    const deltaY =
      transcriptControl && !state.ready ? inlineWheelDelta(state) : 0;
    samples.push({ ...state, deltaY });
    if (
      state.ready &&
      previous?.x === state.point.x &&
      previous.y === state.point.y
    )
      return state.point;
    previous = state.ready ? state.point : null;
    if (deltaY && i < 11) await wheel({ ...state.wheel, deltaY });
  }
  return null;
}

// This is continuation coverage, not a claim that the baseline had a reading defect.
export async function captureInlineContinuation({
  send,
  observe,
  settle,
  capture,
  evidence,
  options,
}) {
  const trip = {
    theme: options.theme,
    status: "running",
    samples: [],
    wheels: [],
  };
  (evidence.inlineContinuationTrips ??= []).push(trip);
  const identity = (s) => ({
    turns: s.turns.map((t) => [
      t.answerItemId,
      t.endItemId,
      t.text,
      t.answer,
      t.expanded,
      t.traces.map((d) => [d.expanded, d.detailText]),
    ]),
    dock: [s.dockOpen, s.dockVisible],
    preserved: ["output", "page", "draft", "composer", "left"].map(
      (k) => s.continuation[k],
    ),
    mutations: [
      "informationUpdates",
      "machineThreadCreateCalls",
      "sideChatCreateCommandCalls",
    ].map((k) => s.telemetry[k]),
    calls: s.telemetry.protocolCalls.filter(
      (m) =>
        ![
          "zen/thread/read",
          "zen/thread/resume",
          "zen/thread/resume-window",
          "zen/thread/questions/list",
        ].includes(m),
    ),
  });
  const frame = (s) => ({ end: s.turns[1].answerEnd, top: s.continuation.top });
  try {
    const baseline = await observe();
    assert.deepEqual(
      baseline.turns.map((t) => t.answerItemId),
      ["result-answer-0", "result-answer-1"],
    );
    assert(
      baseline.dockOpen &&
        baseline.dockVisible &&
        baseline.continuation.composer,
    );
    assert(baseline.turns[1].traces.some((t) => t.expanded === "true"));
    assert.deepEqual(
      baseline.turns.map((t) => t.expanded),
      ["false", "true"],
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      await settle();
      const state = await observe(),
        end = state.turns[1]?.answerEnd;
      trip.samples.push(state);
      assert.deepEqual(
        identity(state),
        identity(baseline),
        "Answers, disclosure, dock, Composer and non-transcript offsets unchanged",
      );
      assert(
        end?.rect && !end.hiddenBy,
        "Original final sentence exists in the displayed answer",
      );
      if (end.visible && end.hit) {
        await settle();
        const stable = await observe();
        assert.deepEqual(identity(stable), identity(baseline));
        if (JSON.stringify(frame(stable)) !== JSON.stringify(frame(state)))
          continue;
        trip.screenshotBefore = stable;
        await capture(
          `reading-${options.name}-inline-trace-answer-end`,
          options,
          "reading",
        );
        const after = await observe();
        assert.deepEqual(identity(after), identity(baseline));
        assert.deepEqual(
          frame(after),
          frame(stable),
          "Screenshot-time final Range and outer offset stay stable",
        );
        assert(
          after.turns[1].answerEnd.visible && after.turns[1].answerEnd.hit,
          "Sentence remains exposed after screenshot",
        );
        trip.after = after;
        trip.status = "passed";
        trip.outcome = trip.wheels.length
          ? "reached-with-wheel"
          : "already-visible";
        return;
      }
      const { top, maxTop, wheel } = state.continuation;
      assert(
        attempt < 5 &&
          wheel &&
          end.rect.bottom > end.limit.bottom &&
          top < maxTop - 1,
        "No safe transcript-owned continuation scroll; do not scroll around an in-band cover",
      );
      const deltaY = Math.min(
        240,
        maxTop - top,
        Math.ceil(end.rect.bottom - end.limit.bottom + 8),
      );
      trip.wheels.push({ ...wheel, deltaY, beforeTop: top });
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...wheel,
        deltaX: 0,
        deltaY,
      });
      let next;
      for (let sample = 0; sample < 8; sample++) {
        await settle();
        next = await observe();
        assert.deepEqual(
          identity(next),
          identity(baseline),
          "Wheel did not move output or page",
        );
        if (next.continuation.top > top) break;
      }
      trip.wheels.at(-1).afterTop = next.continuation.top;
      assert(
        next.continuation.top > top,
        "Native wheel advances the transcript",
      );
    }
    assert.fail(
      "Final sentence geometry did not settle within the bounded probe",
    );
  } catch (error) {
    trip.status = "failed";
    trip.error = String(error);
    throw error;
  }
}

export function verifyNestedOutput(state, baseline, phase = "wheel") {
  const output = state.nestedOutput;
  assert(
    output?.count === 1 && output.role === "region" && output.tabIndex === 0,
    "One real keyboard-accessible output region",
  );
  assert(
    output.clientHeight > 0 && output.maxTop > 240,
    "Opt-in output genuinely overflows",
  );
  assert(
    output.clientWidth > 0 &&
      output.scrollWidth <= output.clientWidth &&
      output.left === 0 &&
      !output.pageHorizontalOverflow,
    "Long inert output wraps without horizontal escape",
  );
  assert(state.dockOpen && state.dockVisible && state.continuation.composer);
  assert.deepEqual(
    state.turns.map((t) => [t.answerItemId, t.expanded]),
    [
      ["result-answer-0", "false"],
      ["result-answer-1", "true"],
    ],
  );
  assert(
    state.turns[1].traces.some(
      (t) => t.expanded === "true" && t.detailText.includes("Exit code 1"),
    ),
    "Original failed result stays expanded",
  );
  for (const key of [
    "informationUpdates",
    "machineThreadCreateCalls",
    "sideChatCreateCommandCalls",
  ])
    assert.equal(state.telemetry[key], 0);
  assert(
    !state.telemetry.protocolCalls.some((m) =>
      /zen\/(turn|thread)\/(send|create|interrupt)/.test(m),
    ),
  );
  if (baseline) {
    const identity = (s) => ({
      turns: s.turns.map((t) => [
        t.answerItemId,
        t.endItemId,
        t.text,
        t.answer,
        t.expanded,
      ]),
      offsets: [
        ["tab", "outer-clearance", "outer-end"].includes(phase)
          ? null
          : s.continuation.top,
        s.continuation.left,
        s.continuation.page,
      ],
      composer: [s.continuation.composer, s.continuation.draft],
      calls: s.telemetry.protocolCalls.filter(
        (m) =>
          ![
            "zen/thread/read",
            "zen/thread/resume",
            "zen/thread/resume-window",
            "zen/thread/questions/list",
          ].includes(m),
      ),
    });
    assert.deepEqual(
      identity(state),
      identity(baseline),
      "Inner wheel preserves outer/page offsets, conversation, Composer and read-only state",
    );
    if (phase === "outer-clearance" || phase === "outer-end")
      assert.deepEqual(
        [output.top, output.maxTop, state.continuation.output],
        [
          baseline.nestedOutput.top,
          baseline.nestedOutput.maxTop,
          baseline.continuation.output,
        ],
        "Separate outer wheel preserves the reached inner bottom exactly",
      );
    if (phase !== "head")
      assert(
        output.focused,
        "Native Tab focus stays on output during inner scrolling",
      );
  }
  if (phase === "end" || phase === "outer-end")
    assert(
      output.maxTop - output.top <= 1 && output.end.visible && output.end.hit,
      "Unique original output end fully paints at the inner bottom",
    );
}

export function nestedOuterClearanceDelta(state) {
  const output = state.nestedOutput,
    end = output.end;
  assert(
    output.maxTop - output.top <= 1,
    "Only a reached inner bottom can request outer clearance",
  );
  if (end.visible && end.hit) return 0;
  const r = end.rect,
    limit = end.limit;
  assert(
    r?.width > 0 &&
      r.height > 0 &&
      !end.hiddenBy &&
      !end.visible &&
      r.x >= limit.left &&
      r.right <= limit.right &&
      r.y >= limit.top &&
      r.bottom > limit.bottom &&
      limit.bottom === state.continuation.composer[1] &&
      Array.isArray(end.clips) &&
      end.clips.length > 0 &&
      end.clips.every(
        (clip) =>
          (!(clip.x || clip.paint) ||
            (r.x >= clip.left && r.right <= clip.right)) &&
          (!(clip.y || clip.paint) ||
            (r.y >= clip.top && r.bottom <= clip.bottom)),
      ),
    "Tail is not solely below Composer; no scroll around unknown clipping or an in-band cover",
  );
  const { top, maxTop, wheel } = state.continuation;
  assert(
    wheel &&
      output.rect &&
      !(
        wheel.x >= output.rect.left &&
        wheel.x <= output.rect.right &&
        wheel.y >= output.rect.top &&
        wheel.y <= output.rect.bottom
      ) &&
      top < maxTop - 1,
    "No safe transcript-owned clearance point or remaining range",
  );
  return Math.min(120, maxTop - top, Math.ceil(r.bottom - limit.bottom + 8));
}

export async function captureNestedOutput({
  send,
  observe,
  settle,
  capture,
  evidence,
  options,
}) {
  const started = Date.now();
  const trip = { status: "running", phase: "head", wheels: [], tabs: 0 };
  (evidence.nestedOutputTrips ??= []).push(trip);
  const frame = (s) => [s.nestedOutput, s.continuation];
  const stable = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await settle();
      const first = await observe();
      await settle();
      const second = await observe();
      trip.lastObservation = second;
      if (JSON.stringify(frame(first)) === JSON.stringify(frame(second)))
        return second;
    }
    assert.fail("Nested output geometry did not settle");
  };
  const snapshot = async (name, state) => {
    await capture(
      `reading-${options.name}-nested-output-${name}`,
      options,
      "reading",
    );
    const after = await observe();
    assert.deepEqual(
      frame(after),
      frame(state),
      "Screenshot-time output/outer geometry unchanged",
    );
    verifyNestedOutput(after, state, name === "head" ? "head" : "end");
    return after;
  };
  try {
    const head = await stable();
    verifyNestedOutput(head);
    assert(
      head.nestedOutput.top === 0 &&
        head.nestedOutput.head.visible &&
        head.nestedOutput.head.hit,
      "Original output head is painted before keyboard entry",
    );
    trip.head = await snapshot("head", head);
    // Start from the actual disclosure click; never assign focus in script.
    let focused = head;
    while (!focused.nestedOutput.focused && trip.tabs < 24) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      trip.tabs++;
      await settle();
      focused = await observe();
    }
    assert(
      trip.tabs > 0 && focused.nestedOutput.focused,
      "Real Tab reaches the output region",
    );
    const baseline = await stable();
    verifyNestedOutput(baseline, head, "tab");
    assert(baseline.nestedOutput.focused && baseline.nestedOutput.top === 0);
    trip.focused = baseline;
    trip.phase = "inner-scroll";
    let state = baseline;
    for (
      let attempt = 0;
      attempt < 8 && state.nestedOutput.maxTop - state.nestedOutput.top > 1;
      attempt++
    ) {
      const { top, maxTop, wheel } = state.nestedOutput;
      assert(wheel, "No safe exact output-owned wheel point");
      const input = {
        ...wheel,
        deltaX: 0,
        deltaY: Math.min(240, maxTop - top),
      };
      const wheelReceipt = {
        input,
        beforeTop: top,
        delivery: "pending",
        samples: [],
      };
      trip.wheels.push(wheelReceipt);
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...input });
      wheelReceipt.delivery = "acknowledged";
      for (let sample = 0; sample < 8; sample++) {
        await settle();
        state = await observe();
        wheelReceipt.samples.push(state);
        verifyNestedOutput(state, baseline);
        if (state.nestedOutput.top > top) break;
      }
      assert(
        state.nestedOutput.top > top,
        "Native wheel advances only the nested output",
      );
      wheelReceipt.afterTop = state.nestedOutput.top;
      state = await stable();
      wheelReceipt.settled = state;
      verifyNestedOutput(state, baseline);
    }
    assert(trip.wheels.length > 0);
    trip.phase = "fixed-outer-end";
    const innerEnd = state;
    trip.innerEnd = innerEnd;
    trip.outerClearance = { before: state, wheels: [] };
    for (let attempt = 0; attempt < 3; attempt++) {
      const deltaY = nestedOuterClearanceDelta(state);
      if (!deltaY) break;
      trip.phase = "outer-clearance";
      const top = state.continuation.top;
      const input = { ...state.continuation.wheel, deltaX: 0, deltaY };
      const wheelReceipt = {
        input,
        beforeTop: top,
        delivery: "pending",
        samples: [],
      };
      trip.outerClearance.wheels.push(wheelReceipt);
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...input });
      wheelReceipt.delivery = "acknowledged";
      for (let sample = 0; sample < 8; sample++) {
        await settle();
        state = await observe();
        wheelReceipt.samples.push(state);
        verifyNestedOutput(state, innerEnd, "outer-clearance");
        if (state.continuation.top > top) break;
      }
      assert(
        state.continuation.top > top,
        "Acknowledged outer wheel must advance before any further input",
      );
      wheelReceipt.afterTop = state.continuation.top;
      state = await stable();
      wheelReceipt.settled = state;
      verifyNestedOutput(state, innerEnd, "outer-clearance");
    }
    trip.outerClearance.after = state;
    trip.phase = "end-paint";
    verifyNestedOutput(state, innerEnd, "outer-end");
    trip.end = await snapshot("end", state);
    verifyNestedOutput(trip.end, innerEnd, "outer-end");
    // Existing outer-owner proof now runs independently with inner end offset fixed.
    await captureInlineContinuation({
      send,
      observe,
      settle,
      capture,
      evidence,
      options,
    });
    trip.transcriptReturn = evidence.inlineContinuationTrips.at(-1).outcome;
    assert(
      evidence.inlineContinuationTrips.at(-1).screenshotBefore.nestedOutput
        .focused &&
        evidence.inlineContinuationTrips.at(-1).after.nestedOutput.focused,
      "Output retains native keyboard focus after the separate transcript continuation",
    );
    trip.status = "passed";
  } catch (error) {
    trip.status = "failed";
    trip.error = String(error);
    throw error;
  } finally {
    trip.elapsedMs = Date.now() - started;
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
  nested = false,
}) {
  const startedAt = Date.now();
  const target = new URL(url);
  target.searchParams.set("results", "1");
  target.searchParams.set("inlineTrace", "1");
  if (nested) target.searchParams.set("nestedOutput", "1");
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
  const settle = () =>
    evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
  const click = async (selector, transcriptControl = false) => {
    const attempt = { theme: options.theme, selector, samples: [] };
    (evidence.inlineTraceClickAttempts ??= []).push(attempt);
    const sample = () =>
      evaluate(
        `(${observeInlineClick.toString()})(${JSON.stringify(selector)},${transcriptControl})`,
      );
    const point = await seekInlineClick({
      sample,
      settle,
      wheel: (p) =>
        send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          deltaX: 0,
          ...p,
        }),
      samples: attempt.samples,
      transcriptControl,
    });
    assert(point, `Inline Trace target not visible/hittable: ${selector}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await settle();
    const afterHover = await sample();
    attempt.afterHover = afterHover;
    assert(
      afterHover.ready &&
        afterHover.point.x === point.x &&
        afterHover.point.y === point.y,
      `Inline Trace target moved/occluded on hover: ${selector}`,
    );
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
  // Preserve the current viewport; use native wheel input only if a real
  // transcript target is off the readable band and there is room to scroll.
  for (let i = 0; i < 2; i++)
    if ((await observe()).turns[i].expanded === "true")
      await click(`${selectors[i]} .turn-toggle`, true);
  await wait(
    "[...document.querySelectorAll('.messages .turn-toggle')].every(e=>e.getAttribute('aria-expanded')==='false')",
  );
  await click(`${selectors[1]} .turn-toggle`, true);
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
    await click(traceSelector, true);
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
  if (nested) {
    await click(traceSelector, true);
    await wait(
      `document.querySelector(${JSON.stringify(traceSelector)})?.getAttribute('aria-expanded')==='true'`,
    );
    await captureNestedOutput({
      send,
      settle,
      capture,
      evidence,
      options,
      observe: () =>
        evaluate(`(${observeInlineTrace.toString()})(true,null,true)`),
    });
    return;
  }
  const baseline = await stableCapture("failed-collapsed", null, false);
  if (
    await evaluate(
      `document.querySelector(${JSON.stringify(traceSelector)}).getAttribute('aria-expanded')!=='true'`,
    )
  )
    await click(traceSelector, true);
  await wait(
    `document.querySelector(${JSON.stringify(selectors[1])}).textContent.includes('Expected reader_name, received reader_label')`,
  );
  await stableCapture("failed-expanded", baseline, true);
  await captureInlineContinuation({
    send,
    settle,
    capture,
    evidence,
    options,
    observe: () => evaluate(`(${observeInlineTrace.toString()})(true)`),
  });
}

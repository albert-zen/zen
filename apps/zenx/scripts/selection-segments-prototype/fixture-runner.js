/* Browser-only instrumentation. This file does not register key/copy handlers. */
(() => {
  const viewport = document.querySelector("#viewport");
  const container = document.querySelector("#transcript");
  const result = document.querySelector("#result");
  const selection = () => document.getSelection();
  let rows = [],
    keys = [],
    heights = [],
    tops = [],
    baseline = "",
    mode = "full";
  let baselineHostCounts,
    retained = [],
    busy = false;
  const flatOracle = new Map();
  const nativeSlice = (start, end) => {
    const range = document.createRange();
    range.setStartBefore(rows[start]);
    range.setEndAfter(rows[end - 1]);
    selection().removeAllRanges();
    selection().addRange(range);
    return selection().toString();
  };
  const counts = (root = container) => ({
    elements: root.querySelectorAll("*").length,
    buttons: root.querySelectorAll("button").length,
    textCharacters: root.textContent.length,
  });
  const pick = (center) =>
    [...new Set([0, center - 1, center, center + 1, rows.length - 1])]
      .filter((index) => index >= 0 && index < rows.length)
      .map(String);
  const reset = () => {
    selection().removeAllRanges();
    container.innerHTML = Array.from(
      { length: 24 },
      (_, index) => rowHTML[index % rowHTML.length],
    ).join("");
    rows = [...container.children];
    keys = rows.map((row, index) => {
      row.dataset.rowKey = String(index);
      row.dataset.segmentId = `row:${index}`;
      row.dataset.segmentStart = String(index);
      row.dataset.segmentEnd = String(index + 1);
      return String(index);
    });
    heights = rows.map((row) => row.getBoundingClientRect().height);
    tops = heights.map((_, i) =>
      heights.slice(0, i).reduce((a, b) => a + b, 0),
    );
    baselineHostCounts = counts();
    baseline = nativeSlice(0, rows.length);
    // Capture every possible contiguous gap once, only in this oracle fixture.
    // Product projection has no such oracle for never-mounted historical rows.
    flatOracle.clear();
    for (let start = 0; start < rows.length; start++) {
      for (let end = start + 1; end <= rows.length; end++) {
        flatOracle.set(`${start}:${end}`, nativeSlice(start, end));
      }
    }
    selection().removeAllRanges();
    mode = "full";
    retained = keys;
    viewport.scrollTop = tops[12];
    return { baseline, baselineHostCounts };
  };
  const make = (part) => {
    if (part.kind === "row") return rows[part.start];
    const gap = document.createElement("div");
    gap.className = "projection-gap";
    gap.style.height = `${heights.slice(part.start, part.end).reduce((a, b) => a + b, 0)}px`;
    const body = document.createElement("div");
    body.className = "projection-body";
    if (mode === "flat") {
      const pre = document.createElement("pre");
      pre.className = "flat-gap";
      pre.textContent = flatOracle.get(`${part.start}:${part.end}`);
      body.append(pre);
    } else {
      for (let index = part.start; index < part.end; index++)
        body.append(cloneProjection(rows[index], mode));
    }
    gap.append(body);
    return gap;
  };
  const update = (next) => {
    const snapshot = selectionSnapshot(document);
    const locked = protectedSegments(container, selection());
    const protectedGaps = locked
      .filter((node) => node.classList.contains("projection-gap"))
      .map((node) => ({
        start: Number(node.dataset.segmentStart),
        end: Number(node.dataset.segmentEnd),
      }));
    const pinnedRows = locked
      .filter((node) => node.dataset.rowKey !== undefined)
      .map((node) => node.dataset.rowKey);
    retained = [...new Set([...next, ...pinnedRows])];
    applySegments(
      container,
      planSegments(keys, retained, protectedGaps),
      make,
      selection(),
    );
    const after = selectionSnapshot(document);
    return {
      endpointsSame: sameEndpoints(snapshot, after),
      difference: firstDifference(snapshot?.text ?? "", after?.text ?? ""),
    };
  };
  const activate = (candidate) => {
    reset();
    mode = candidate;
    update(pick(12));
    return {
      mode,
      baselineCounts: baselineHostCounts,
      candidateCounts: counts(),
    };
  };
  const select = () => {
    const range = document.createRange();
    range.setStartBefore(container.firstElementChild);
    range.setEndAfter(container.lastElementChild);
    selection().removeAllRanges();
    selection().addRange(range);
    return selection().toString();
  };
  const verify = (candidate) => {
    const metrics = activate(candidate);
    const initial = select();
    // Use actual first/last text nodes so the DOM-only mechanism deliberately
    // exercises stable endpoints. This is not the product's Cocoa Select All.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const all = [];
    while (walker.nextNode()) all.push(walker.currentNode);
    selection().setBaseAndExtent(all[0], 0, all.at(-1), all.at(-1).length);
    const selectedBefore = selectionSnapshot(document);
    const middleBefore = rows[12];
    const movement = update(pick(18));
    const selectedAfter = selectionSnapshot(document);
    return {
      ...metrics,
      wholeSelectionDifference: firstDifference(baseline, initial),
      interiorReplacementDifference: firstDifference(
        selectedBefore.text,
        selectedAfter.text,
      ),
      endpointsSame: movement.endpointsSame,
      retainedBoundaryNodesSame:
        rows[0] === container.firstElementChild &&
        rows.at(-1) === container.lastElementChild,
      oldWindowRetainedIfEndpoint: container.contains(middleBefore),
      rawBaseline: baseline,
      rawCandidate: initial,
      clipboard:
        "NOT RUN; use native product/menu test, no clipboard interception here",
    };
  };
  const fillAll = () => {
    if (
      protectedSegments(container, selection()).some((node) =>
        node.classList.contains("projection-gap"),
      )
    ) {
      return {
        blocked: true,
        reason:
          "Selection already has an endpoint in a projected gap; no endpoint rewrite is allowed",
      };
    }
    const change = update(keys);
    mode = "full";
    return change;
  };
  const runAll = () => {
    busy = true;
    try {
      const report = ["host", "pruned", "flat"].map(verify);
      result.textContent = JSON.stringify(report, null, 2);
      window.segmentFixture.lastReport = report;
      return report;
    } finally {
      busy = false;
    }
  };
  viewport.addEventListener(
    "scroll",
    () => {
      if (busy || mode === "full") return;
      const center = Math.max(
        0,
        tops.findLastIndex((top) => top <= viewport.scrollTop),
      );
      update(pick(center));
    },
    { passive: true },
  );
  // Experimental advanced-selection fallback: fill gaps in place before the
  // original native event, without preventDefault, replay, or Range writes.
  viewport.addEventListener(
    "keydown",
    (event) => {
      if (mode !== "full" && /^(Arrow|Home$|End$|Page)/.test(event.key))
        fillAll();
    },
    true,
  );
  viewport.addEventListener(
    "pointerdown",
    () => {
      if (mode !== "full") fillAll();
    },
    true,
  );
  document.querySelector("#run").onclick = runAll;
  document.querySelector("#full").onclick = () => {
    reset();
    result.textContent = "Full baseline";
  };
  for (const name of ["host", "pruned", "flat"])
    document.querySelector(`#${name}`).onclick = () => {
      result.textContent = JSON.stringify(activate(name), null, 2);
    };
  document.querySelector("#select").onclick = () => {
    select();
  };
  window.segmentFixture = {
    reset,
    activate,
    select,
    update,
    verify,
    runAll,
    fillAll,
    counts,
    lastReport: null,
  };
  reset();
})();

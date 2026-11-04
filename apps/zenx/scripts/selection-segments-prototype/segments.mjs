/* Isolated mechanism, not product code. No clipboard listener or Selection override. */
export function planSegments(keys, retainedKeys, protectedGaps = []) {
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate row key");
  const retained = new Set(retainedKeys);
  const locked = new Map(protectedGaps.map((gap) => [gap.start, gap]));
  const output = [];
  for (let index = 0; index < keys.length;) {
    const pinned = locked.get(index);
    if (pinned) {
      output.push({
        ...pinned,
        kind: "gap",
        id: `gap:${pinned.start}:${pinned.end}`,
      });
      index = pinned.end;
    } else if (retained.has(keys[index])) {
      output.push({
        kind: "row",
        id: `row:${keys[index]}`,
        start: index,
        end: index + 1,
      });
      index++;
    } else {
      const start = index++;
      while (
        index < keys.length &&
        !retained.has(keys[index]) &&
        !locked.has(index)
      )
        index++;
      output.push({
        kind: "gap",
        id: `gap:${start}:${index}`,
        start,
        end: index,
      });
    }
  }
  return output;
}

export function cloneProjection(source, mode = "host") {
  const clone = source.cloneNode(true);
  // cloneNode copies DOM, not React state/listeners. Removing a host element is
  // a separately tested hypothesis, never an assumed serialization invariant.
  if (mode === "pruned") {
    for (const node of clone.querySelectorAll("svg,button")) {
      if (!node.textContent && !node.querySelector("img,input,textarea,select"))
        node.remove();
    }
  }
  return clone;
}

function containsBoundary(node, boundary) {
  return boundary !== null && (node === boundary || node.contains(boundary));
}

export function protectedSegments(container, selection) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
    return [];
  return [...container.children].filter(
    (node) =>
      containsBoundary(node, selection.anchorNode) ||
      containsBoundary(node, selection.focusNode),
  );
}

/**
 * Apply a new ordered partition without moving any surviving DOM node. A stable
 * end sentinel or real boundary row keeps a page-wide Range across insertions.
 * Endpoint-containing gaps are indivisible until the native selection changes.
 */
export function applySegments(container, plan, createNode, selection) {
  const before = [...container.children];
  const byId = new Map(before.map((node) => [node.dataset.segmentId, node]));
  const desired = new Set(plan.map((part) => part.id));
  const protectedNodes = protectedSegments(container, selection);
  if (protectedNodes.some((node) => !desired.has(node.dataset.segmentId))) {
    throw new Error("Refusing to replace a live Selection endpoint segment");
  }
  for (let index = 0; index < plan.length; index++) {
    const part = plan[index];
    if (byId.has(part.id)) continue;
    const next =
      plan
        .slice(index + 1)
        .map((item) => byId.get(item.id))
        .find(Boolean) ?? null;
    const node = createNode(part);
    node.dataset.segmentId = part.id;
    node.dataset.segmentStart = String(part.start);
    node.dataset.segmentEnd = String(part.end);
    container.insertBefore(node, next);
    byId.set(part.id, node);
  }
  for (const node of before) {
    if (!desired.has(node.dataset.segmentId)) node.remove();
  }
  const actual = [...container.children].map((node) => node.dataset.segmentId);
  if (actual.join("\0") !== plan.map((part) => part.id).join("\0")) {
    throw new Error(
      "Existing DOM order changed; reordering is intentionally unsupported",
    );
  }
}

export function selectionSnapshot(document) {
  const selection = document.getSelection();
  return selection
    ? {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
        text: selection.toString(),
        collapsed: selection.isCollapsed,
      }
    : null;
}

export function sameEndpoints(left, right) {
  return (
    !!left &&
    !!right &&
    ["anchorNode", "anchorOffset", "focusNode", "focusOffset"].every(
      (name) => left[name] === right[name],
    )
  );
}

export function firstDifference(expected, actual) {
  if (expected === actual) return null;
  let index = 0;
  while (index < expected.length && expected[index] === actual[index]) index++;
  return {
    index,
    expectedLength: expected.length,
    actualLength: actual.length,
    expected: expected.slice(Math.max(0, index - 24), index + 48),
    actual: actual.slice(Math.max(0, index - 24), index + 48),
  };
}

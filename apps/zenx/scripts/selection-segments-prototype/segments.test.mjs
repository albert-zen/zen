import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import {
  planSegments,
  cloneProjection,
  applySegments,
  protectedSegments,
  selectionSnapshot,
  sameEndpoints,
  firstDifference,
} from "./segments.mjs";
const require = createRequire(path.resolve("package.json"));
const { JSDOM } = require("jsdom");

function setup(count = 12) {
  const document = new JSDOM(
    '<main><input value="local draft"><div id="rows"></div></main>',
  ).window.document;
  const container = document.querySelector("#rows");
  const keys = Array.from({ length: count }, (_, i) => String(i));
  const source = keys.map((key) => {
    const row = document.createElement("article");
    row.dataset.rowKey = key;
    row.innerHTML = `<p>User ${key}</p><button>Worked</button><div><p>Agent ${key}</p><time>12:00</time></div>`;
    return row;
  });
  const create = (part) => {
    if (part.kind === "row") return source[part.start];
    const gap = document.createElement("div");
    for (let i = part.start; i < part.end; i++)
      gap.append(cloneProjection(source[i]));
    return gap;
  };
  const update = (retained, protectedGaps = []) =>
    applySegments(
      container,
      planSegments(keys, retained, protectedGaps),
      create,
      document.getSelection(),
    );
  return { document, container, source, keys, update };
}

test("partition is ordered, complete, unique, and bounded by retained runs", () => {
  const { keys } = setup(5000);
  const plan = planSegments(keys, ["0", "100", "101", "102", "4999"]);
  assert.equal(plan.filter((x) => x.kind === "gap").length, 2);
  assert.equal(plan.length, 7);
  assert.deepEqual(
    plan.flatMap((x) => keys.slice(x.start, x.end)),
    keys,
  );
  assert.throws(() => planSegments(["a", "a"], []), /Duplicate/);
});

test("host projection preserves exact DOM markup, including invisible text labels", () => {
  const { source } = setup();
  const clone = cloneProjection(source[0]);
  assert.equal(clone.outerHTML, source[0].outerHTML);
  assert.notEqual(clone, source[0]);
  source[0].lastChild.style.opacity = "0";
  assert.equal(cloneProjection(source[0]).textContent, source[0].textContent);
});

test("pruned candidate keeps text-bearing native buttons and timestamps", () => {
  const { source } = setup();
  source[0].innerHTML +=
    '<button aria-label="Copy"><svg></svg></button><button>Copy</button>';
  const clone = cloneProjection(source[0], "pruned");
  assert.equal(clone.querySelectorAll("button").length, 2);
  assert.equal(clone.textContent, source[0].textContent);
  // textContent equality is only a structural invariant, not native equality.
});

test("interior gap replacement preserves real native Range endpoint node identities", () => {
  const { document, container, source, update } = setup();
  update(["0", "3", "4", "11"]);
  const selection = document.getSelection();
  selection.setBaseAndExtent(
    source[0].firstChild.firstChild,
    0,
    source[11].lastChild.lastChild.firstChild,
    5,
  );
  const before = selectionSnapshot(document);
  const visible = source[4];
  update(["0", "4", "7", "8", "11"]);
  const after = selectionSnapshot(document);
  assert.ok(sameEndpoints(before, after));
  assert.equal(before.text, after.text);
  assert.equal(container.querySelector('[data-segment-id="row:4"]'), visible);
  assert.equal(container.querySelectorAll("[data-row-key]").length, 12);
});

test("narrowed Selection pins its exact gap and does not rewrite endpoints", () => {
  const { document, container, update } = setup();
  update(["0", "4", "11"]);
  const gap = container.querySelector('[data-segment-id="gap:1:4"]');
  const text = gap.firstChild.firstChild.firstChild;
  document.getSelection().setBaseAndExtent(text, 1, text, 5);
  const before = selectionSnapshot(document);
  assert.throws(() => update(["0", "2", "4", "11"]), /endpoint segment/);
  const pinned = protectedSegments(container, document.getSelection()).map(
    (node) => ({
      start: Number(node.dataset.segmentStart),
      end: Number(node.dataset.segmentEnd),
    }),
  );
  update(["0", "2", "7", "11"], pinned);
  assert.ok(sameEndpoints(before, selectionSnapshot(document)));
  assert.equal(container.querySelector('[data-segment-id="gap:1:4"]'), gap);
});

test("local editor selection is unchanged by unrelated DOM materialization", () => {
  const { document, update } = setup();
  const input = document.querySelector("input");
  input.focus();
  input.setSelectionRange(1, 5);
  update(["0", "3", "11"]);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 1);
  assert.equal(input.selectionEnd, 5);
});

test("raw comparator preserves whitespace mismatches without normalization", () => {
  assert.deepEqual(firstDifference("x\n", "x\n"), null);
  assert.equal(firstDifference("x\n", "x").index, 1);
  assert.equal(firstDifference("x\n\n", "x\n").expectedLength, 3);
});

test("fill-all fallback retains viewport, visible row, and Selection endpoint identity", () => {
  const { document, container, source, keys, update } = setup();
  update(["0", "4", "11"]);
  document
    .getSelection()
    .setBaseAndExtent(
      source[0].firstChild.firstChild,
      1,
      source[11].lastChild.lastChild.firstChild,
      4,
    );
  const before = selectionSnapshot(document);
  const row = source[4];
  update(keys);
  assert.ok(sameEndpoints(before, selectionSnapshot(document)));
  assert.equal(document.querySelector("#rows"), container);
  assert.equal(container.children[4], row);
  assert.equal(
    container.querySelectorAll('[data-segment-id^="gap:"]').length,
    0,
  );
  assert.equal(before.text, selectionSnapshot(document).text);
});

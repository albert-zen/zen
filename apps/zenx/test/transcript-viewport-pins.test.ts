import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  protectedTranscriptRows,
  readTranscriptAnchor,
} from "../src/renderer/src/transcript-viewport-pins.js";

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 500,
    width: 500,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON() {},
  };
}

function fixture() {
  const dom = new JSDOM(
    `<div id="viewport"><div data-transcript-row-key="a">Alpha <button>Control</button></div><div data-transcript-row-key="b">Beta</div><div data-transcript-row-key="c">Gamma</div></div><p>Elsewhere</p>`,
  );
  return {
    dom,
    viewport: dom.window.document.getElementById("viewport")!,
    rows: [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        "[data-transcript-row-key]",
      ),
    ],
  };
}
test("focused row is retained and releases when focus leaves the transcript", () => {
  const { dom, viewport } = fixture();
  dom.window.document.querySelector<HTMLButtonElement>("button")!.focus();
  assert.deepEqual(protectedTranscriptRows(viewport, false), ["a"]);
  dom.window.document.querySelector<HTMLButtonElement>("button")!.blur();
  assert.deepEqual(protectedTranscriptRows(viewport, false), []);
  dom.window.close();
});
test("native cross-row ranges protect their whole mounted interval, not just endpoints", () => {
  const { dom, viewport, rows } = fixture();
  const range = dom.window.document.createRange();
  range.setStart(rows[0]!.firstChild!, 2);
  range.setEnd(rows[2]!.firstChild!, 2);
  dom.window.getSelection()!.addRange(range);
  assert.deepEqual(protectedTranscriptRows(viewport, false), ["a", "b", "c"]);
  assert.equal(dom.window.getSelection()!.toString().includes("Beta"), true);
  dom.window.getSelection()!.removeAllRanges();
  assert.deepEqual(protectedTranscriptRows(viewport, false), []);
  dom.window.close();
});
test("pointer selection protects rows before an active native range exists", () => {
  const { dom, viewport } = fixture();
  assert.deepEqual(protectedTranscriptRows(viewport, true), ["a", "b", "c"]);
  assert.deepEqual(protectedTranscriptRows(viewport, false), []);
  dom.window.close();
});
test("outside selection does not pin this viewport", () => {
  const { dom, viewport } = fixture();
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.querySelector("p")!);
  dom.window.getSelection()!.addRange(range);
  assert.deepEqual(protectedTranscriptRows(viewport, false), []);
  dom.window.close();
});
test("anchor identity uses visual row order and actual within-row offset", () => {
  const { dom, viewport, rows } = fixture();
  viewport.getBoundingClientRect = () => rect(100, 600);
  rows[0]!.getBoundingClientRect = () => rect(180, 250);
  rows[1]!.getBoundingClientRect = () => rect(40, 70);
  rows[2]!.getBoundingClientRect = () => rect(75, 180);
  assert.deepEqual(readTranscriptAnchor(viewport), { key: "c", offset: -25 });
  dom.window.close();
});

test("anchor selection preserves the stable visual-order oracle for edge cases", () => {
  const cases: {
    name: string;
    rows: [key: string, top: number, bottom: number][];
    expected: { key: string; offset: number } | null;
  }[] = [
    { name: "empty viewport", rows: [], expected: null },
    {
      name: "all rows above or ending exactly at the viewport top",
      rows: [
        ["a", 40, 70],
        ["b", 75, 100],
        ["c", 100, 100],
      ],
      expected: null,
    },
    {
      name: "reverse visual order and variable heights",
      rows: [
        ["a", 400, 450],
        ["b", 180, 390],
        ["c", 75, 180],
      ],
      expected: { key: "c", offset: -25 },
    },
    {
      name: "DOM-order ties retain the first row, even with different heights",
      rows: [
        ["a", 75, 180],
        ["b", 75, 400],
        ["c", 180, 200],
      ],
      expected: { key: "a", offset: -25 },
    },
    {
      name: "zero-height rows below the viewport top remain eligible",
      rows: [
        ["a", 150, 150],
        ["b", 100, 100],
        ["c", 110, 110],
      ],
      expected: { key: "c", offset: 10 },
    },
    {
      name: "there is no viewport-bottom cutoff",
      rows: [
        ["a", 900, 950],
        ["b", 700, 750],
      ],
      expected: { key: "b", offset: 600 },
    },
    {
      name: "a keyless winning row does not fall through to a keyed row",
      rows: [
        ["", 75, 180],
        ["b", 110, 140],
      ],
      expected: null,
    },
    {
      name: "a keyless tie does not fall through to a keyed row",
      rows: [
        ["", 75, 180],
        ["b", 75, 140],
      ],
      expected: null,
    },
    {
      name: "a keyless row does not suppress an earlier keyed tie",
      rows: [
        ["a", 75, 180],
        ["", 75, 140],
      ],
      expected: { key: "a", offset: -25 },
    },
    {
      name: "negative fractional geometry preserves the exact offset",
      rows: [
        ["a", -12.5, 100.25],
        ["b", 100.125, 200],
      ],
      expected: { key: "a", offset: -112.5 },
    },
  ];
  // Virtualized DOM slots may appear in any order. Check every permutation,
  // including both stable tie winners, against the previous filter/sort rule.
  const permutedRows: [string, number, number][] = [
    ["a", 75, 180],
    ["b", 75, 400],
    ["c", 40, 100],
  ];
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    const rows = order.map((index) => permutedRows[index]!);
    cases.push({
      name: `visual tie permutation ${order.join(",")}`,
      rows,
      expected: {
        key: order.indexOf(0) < order.indexOf(1) ? "a" : "b",
        offset: -25,
      },
    });
  }
  for (const scenario of cases) {
    const { dom, viewport, rows } = fixture();
    try {
      viewport.getBoundingClientRect = () => rect(100, 600);
      rows.forEach((row, index) => {
        const geometry = scenario.rows[index];
        if (!geometry) return row.remove();
        row.dataset.transcriptRowKey = geometry[0];
        row.getBoundingClientRect = () => rect(geometry[1], geometry[2]);
      });
      const previousWinner = scenario.rows
        .filter(([, , bottom]) => bottom > 100)
        .sort(([, a], [, b]) => a - b)[0];
      const previousAnchor = previousWinner?.[0]
        ? { key: previousWinner[0], offset: previousWinner[1] - 100 }
        : null;
      assert.deepEqual(previousAnchor, scenario.expected, scenario.name);
      assert.deepEqual(
        readTranscriptAnchor(viewport),
        previousAnchor,
        scenario.name,
      );
    } finally {
      dom.window.close();
    }
  }
});

test("anchor capture reads each of 5000 mounted row rectangles exactly once", () => {
  const { dom, viewport } = fixture();
  try {
    viewport.replaceChildren();
    let viewportReads = 0;
    const rowReads = Array<number>(5000).fill(0);
    viewport.getBoundingClientRect = () => {
      ++viewportReads;
      return rect(100, 600);
    };
    for (let index = 0; index < rowReads.length; index++) {
      const row = dom.window.document.createElement("div");
      row.dataset.transcriptRowKey = `row-${index}`;
      // The earliest visual row is last in DOM order, so an early exit is wrong.
      row.getBoundingClientRect = () => {
        rowReads[index]!++;
        const top = 100 + rowReads.length - index;
        return rect(top, top + 10);
      };
      viewport.append(row);
    }
    assert.deepEqual(readTranscriptAnchor(viewport), {
      key: "row-4999",
      offset: 1,
    });
    assert.equal(viewportReads, 1);
    assert.equal(
      rowReads.reduce((total, reads) => total + reads, 0),
      5000,
    );
    assert.equal(
      rowReads.every((reads) => reads === 1),
      true,
    );
  } finally {
    dom.window.close();
  }
});

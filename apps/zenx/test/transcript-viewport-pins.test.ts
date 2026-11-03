import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  protectedTranscriptRows,
  readTranscriptAnchor,
} from "../src/renderer/src/transcript-viewport-pins.js";

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
  const rect = (top: number, bottom: number) => ({
    top,
    bottom,
    left: 0,
    right: 500,
    width: 500,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON() {},
  });
  viewport.getBoundingClientRect = () => rect(100, 600);
  rows[0]!.getBoundingClientRect = () => rect(180, 250);
  rows[1]!.getBoundingClientRect = () => rect(40, 70);
  rows[2]!.getBoundingClientRect = () => rect(75, 180);
  assert.deepEqual(readTranscriptAnchor(viewport), { key: "c", offset: -25 });
  dom.window.close();
});

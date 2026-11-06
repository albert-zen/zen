import assert from "node:assert/strict";
import test from "node:test";
import { steerPreviewColumn } from "../src/renderer/src/steer-preview-column.js";
for (const normalScrollbar of [0, 10]) {
  for (const pendingScrollbar of [0, 10]) {
    for (const viewport of [390, 1100]) {
      test(`steer content alignment: viewport ${viewport}, scrollbars ${normalScrollbar}/${pendingScrollbar}`, () => {
        const width = Math.min(840, viewport - normalScrollbar - 48);
        const left = (viewport - normalScrollbar - width) / 2;
        const shelfLeft = (viewport - Math.min(840, viewport - 48)) / 2;
        const geometry = steerPreviewColumn(
          { left, width },
          shelfLeft,
          pendingScrollbar,
        );
        assert.equal(shelfLeft + geometry.left, left);
        assert.equal(
          shelfLeft + geometry.left + geometry.width - pendingScrollbar,
          left + width,
        );
      });
    }
  }
}

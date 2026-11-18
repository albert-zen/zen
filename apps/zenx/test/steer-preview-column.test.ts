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

for (const scrollbar of [0, 10, 16]) {
  test(`unified tray puts borders and ${scrollbar}px gutter outside the message column`, () => {
    const column = { left: 24, width: 342 };
    const parentContentLeft = 24;
    const borderLeft = 1;
    const borderRight = 1;
    const nonContentWidth = borderLeft + borderRight + scrollbar;
    const geometry = steerPreviewColumn(
      column,
      parentContentLeft + borderLeft,
      nonContentWidth,
    );
    const contentLeft = parentContentLeft + geometry.left + borderLeft;
    assert.equal(contentLeft, column.left);
    assert.equal(contentLeft + geometry.width - nonContentWidth, 366);
    assert.ok(parentContentLeft + geometry.left >= 0);
    assert.ok(parentContentLeft + geometry.left + geometry.width <= 390);
  });
}

for (const column of [
  { left: 366.5, width: 800, origin: 371.5 },
  { left: 392, width: 736, origin: 392 },
  { left: 952.5, width: 318, origin: 960.5 },
]) {
  test(`Composer border box follows measured transcript at ${column.left}/${column.width}`, () => {
    const geometry = steerPreviewColumn(column, column.origin, 0);
    assert.equal(column.origin + geometry.left, column.left);
    assert.equal(geometry.width, column.width);
    // Queue border/gutter compensation remains separate from the Composer box.
    const tray = steerPreviewColumn(column, column.origin + 1, 12);
    assert.equal(column.origin + 1 + tray.left, column.left);
    assert.equal(tray.width - 12, geometry.width);
  });
}

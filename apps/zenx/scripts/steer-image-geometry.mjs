import assert from "node:assert/strict";

/** Compare actual production browser rectangles, not JSDOM geometry. */
export function assertSteerGeometry(geometry, count, scene) {
  assert.equal(geometry.overflow, false, `${scene}: horizontal overflow`);
  assert.ok(geometry.pending.bubble, `${scene}: missing question body bubble`);
  assert.ok(
    geometry.pending.separate,
    `${scene}: images must be outside text bubble`,
  );
  assert.equal(
    geometry.pending.text.trim(),
    geometry.normal.text.trim(),
    `${scene}: exact body retained`,
  );
  assert.ok(
    Math.abs(geometry.pending.bubble.right - geometry.normal.bubble.right) <= 2,
    `${scene}: body right edges differ: ${JSON.stringify(geometry)}`,
  );
  assert.equal(geometry.pending.images.length, count);
  for (let i = 0; i < count; i++) {
    assert.ok(
      geometry.pending.images[i].width <= 120.5 &&
        geometry.pending.images[i].height <= 120.5,
      `${scene}: oversized pending thumbnail`,
    );
    assert.ok(
      Math.abs(
        geometry.pending.images[i].width - geometry.normal.images[i].width,
      ) <= 2,
      `${scene}: thumbnail widths differ`,
    );
  }
  assert.ok(
    Math.abs(
      geometry.pending.images.at(-1).right -
        geometry.normal.images.at(-1).right,
    ) <= 2,
    `${scene}: image right edges differ`,
  );
}

/** DOM extraction also separates disclosure summary from complete message body. */
export function measureSteerComparison(root) {
  const normal = root.querySelector(
    '[data-sent-message-id="synthetic-normal"]',
  );
  const pending = root.querySelector(".pending-steer-panel ol > li");
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const measure = (row, isPending) => {
    const bubble = row?.querySelector(".user-bubble");
    const disclosure = row?.querySelector(".pending-steer-message");
    return {
      row: rect(row),
      bubble: rect(bubble),
      images: [...(row?.querySelectorAll(".image-thumbnail") ?? [])].map(rect),
      separate:
        !!row?.querySelector(".message-images") &&
        !bubble?.contains(row.querySelector(".message-images")),
      text: (isPending ? row?.querySelector(".pending-steer-text") : bubble)
        ?.textContent,
      disclosure: disclosure
        ? {
            open: disclosure.open,
            summary: disclosure.querySelector("summary")?.textContent,
          }
        : null,
    };
  };
  return {
    normal: measure(normal, false),
    pending: measure(pending, true),
    overflow: root.documentElement.scrollWidth > root.defaultView.innerWidth,
  };
}

export function assertSteerDisclosure(geometry, longBody, scene) {
  if (!longBody) {
    assert.equal(
      geometry.pending.disclosure,
      null,
      `${scene}: short body should not need disclosure`,
    );
    return;
  }
  assert.ok(
    geometry.pending.disclosure?.open,
    `${scene}: long body disclosure must be opened`,
  );
  assert.equal(
    geometry.pending.disclosure.summary,
    geometry.pending.text.slice(0, 240) + "…",
    `${scene}: summary must be a bounded prefix, not the full body`,
  );
}

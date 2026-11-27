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
  assert.equal(
    typeof geometry.desktop,
    "boolean",
    `${scene}: missing media observation`,
  );
  let bodyRight = geometry.normal.bubble.right;
  let imageRight = geometry.normal.images.at(-1).right;
  if (geometry.desktop) {
    const { tray, composer } = geometry;
    assert.ok(
      tray?.rect && composer,
      `${scene}: missing desktop frame observations`,
    );
    for (const edge of ["left", "right"])
      assert.ok(
        Number.isFinite(tray.rect[edge]) &&
          Number.isFinite(composer[edge]) &&
          Math.abs(tray.rect[edge] - composer[edge]) <= 1,
        `${scene}: pending outer frame differs from Composer ${edge}`,
      );
    assert.ok(
      Number.isFinite(tray.clientLeft) &&
        tray.clientLeft >= 0 &&
        Number.isFinite(tray.clientWidth) &&
        tray.clientWidth > 0 &&
        Number.isFinite(tray.offsetWidth) &&
        tray.offsetWidth > 0 &&
        tray.clientLeft + tray.clientWidth <= tray.offsetWidth &&
        Math.abs(tray.offsetWidth - tray.rect.width) <= 1,
      `${scene}: invalid desktop client rail`,
    );
    // Desktop intentionally aligns the outer frames. Native borders and the
    // real scrollbar remain inside that frame; never infer an offset from rows.
    bodyRight = imageRight =
      tray.rect.left + tray.clientLeft + tray.clientWidth;
  }
  assert.ok(
    Math.abs(geometry.pending.bubble.right - bodyRight) <= 2,
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
    Math.abs(geometry.pending.images.at(-1).right - imageRight) <= 2,
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
  const tray = pending?.closest(".pending-tray");
  return {
    desktop:
      root.defaultView.matchMedia?.("(min-width: 961px)").matches ?? null,
    tray: tray
      ? {
          rect: rect(tray),
          clientLeft: tray.clientLeft,
          clientWidth: tray.clientWidth,
          offsetWidth: tray.offsetWidth,
        }
      : null,
    composer: rect(root.querySelector(".bottom-zone > .composer")),
    normal: measure(normal, false),
    pending: measure(pending, true),
    overflow:
      root.documentElement.scrollWidth > root.defaultView.innerWidth ||
      [...root.querySelectorAll(".bottom-zone, .pending-tray")].some(
        (element) => element.scrollWidth > element.clientWidth,
      ),
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

/** Never issue another scroll after an unacknowledged or unobserved input. */
export function assertSteerWheelReceipt(receipt) {
  assert.equal(
    receipt.pointerCommandAcknowledged,
    true,
    "pointer command outcome unknown",
  );
  assert.equal(
    receipt.pointerEvent?.trusted,
    true,
    "trusted pointer movement not observed",
  );
  assert.equal(
    receipt.pointerEvent?.inTranscript,
    true,
    "pointer reached another surface",
  );
  assert.equal(receipt.settled, true, "reader scroll did not settle");
  assert.equal(
    receipt.commandAcknowledged,
    true,
    "wheel command outcome unknown",
  );
  assert.equal(receipt.event?.trusted, true, "trusted wheel not observed");
  assert.equal(
    receipt.event?.inTranscript,
    true,
    "wheel reached another surface",
  );
  assert.ok(receipt.event.deltaY < 0, "wheel direction changed");
  assert.ok(Number.isFinite(receipt.before) && Number.isFinite(receipt.after));
  assert.ok(
    receipt.after < receipt.before,
    "wheel produced no observed upward movement",
  );
}

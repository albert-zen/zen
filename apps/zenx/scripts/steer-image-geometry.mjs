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
    typeof geometry.rails?.desktop,
    "boolean",
    `${scene}: missing rail measurements`,
  );
  let pendingRight = geometry.normal.bubble.right;
  if (geometry.rails.desktop) {
    const rail = geometry.rails;
    const near = (a, b, message, tolerance = 2) =>
      assert.ok(
        Number.isFinite(a) &&
          Number.isFinite(b) &&
          Math.abs(a - b) <= tolerance,
        `${scene}: ${message}: ${JSON.stringify(geometry)}`,
      );
    for (const edge of ["left", "right"]) {
      near(
        rail.tray?.[edge],
        rail.composer?.[edge],
        "tray outer frame differs from Composer",
        1,
      );
      near(
        rail.composer?.[edge],
        rail.canonicalColumn?.[edge],
        "Composer differs from canonical column",
        1,
      );
      near(
        geometry.normal.row?.[edge],
        rail.canonicalColumn?.[edge],
        "canonical row differs from its column",
      );
    }
    assert.ok(
      [
        rail.clientLeft,
        rail.clientWidth,
        rail.offsetWidth,
        rail.borderLeft,
        rail.borderRight,
        rail.paddingLeft,
        rail.paddingRight,
      ].every((value) => Number.isFinite(value) && value >= 0),
      `${scene}: invalid frame measurements`,
    );
    near(
      rail.offsetWidth,
      rail.tray.width,
      "tray frame width differs from native box",
    );
    assert.ok(
      rail.clientWidth > 0 && rail.clientWidth <= rail.offsetWidth,
      `${scene}: invalid tray client width`,
    );
    const safeLeft = rail.tray.left + rail.clientLeft + rail.paddingLeft;
    const safeRight =
      rail.tray.left + rail.clientLeft + rail.clientWidth - rail.paddingRight;
    const rightInset =
      rail.offsetWidth - rail.clientLeft - rail.clientWidth + rail.paddingRight;
    assert.ok(
      safeLeft >= rail.tray.left + rail.borderLeft - 1 &&
        safeRight <= rail.tray.right - rail.borderRight + 1 &&
        safeRight > safeLeft,
      `${scene}: safe rail escapes the tray border`,
    );
    near(
      geometry.pending.row?.left,
      safeLeft,
      "pending row misses safe left rail",
    );
    near(
      geometry.pending.row?.right,
      safeRight,
      "pending row misses safe right rail",
    );
    near(
      geometry.normal.bubble.right,
      rail.canonicalColumn.right,
      "canonical body misses its column",
    );
    near(
      geometry.normal.images.at(-1)?.right,
      rail.canonicalColumn.right,
      "canonical images miss their column",
    );
    near(
      geometry.normal.bubble.right - geometry.pending.bubble.right,
      rail.canonicalColumn.right - rail.tray.right + rightInset,
      "body offset does not equal actual frame border/gutter",
    );
    for (const box of [geometry.pending.bubble, ...geometry.pending.images]) {
      assert.ok(
        Number.isFinite(box?.left) &&
          Number.isFinite(box?.right) &&
          box.left >= safeLeft - 1 &&
          box.right <= safeRight + 1,
        `${scene}: pending content overlaps scrollbar or escapes safe rail`,
      );
    }
    pendingRight = safeRight;
  }
  assert.ok(
    Math.abs(geometry.pending.bubble.right - pendingRight) <= 2,
    `${scene}: body misses its reading rail: ${JSON.stringify(geometry)}`,
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
        (geometry.rails.desktop
          ? pendingRight
          : geometry.normal.images.at(-1).right),
    ) <= 2,
    `${scene}: images miss their reading rail`,
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
  const view = tray?.closest(".thread-view");
  const style = tray ? root.defaultView.getComputedStyle(tray) : null;
  return {
    rails: {
      desktop: root.defaultView.innerWidth >= 961,
      tray: rect(tray),
      composer: rect(tray?.closest(".bottom-zone")?.querySelector(".composer")),
      canonicalColumn: rect(
        view?.querySelector(".virtual-transcript-header, .messages-inner"),
      ),
      clientLeft: tray?.clientLeft,
      clientWidth: tray?.clientWidth,
      offsetWidth: tray?.offsetWidth,
      borderLeft: parseFloat(style?.borderLeftWidth),
      borderRight: parseFloat(style?.borderRightWidth),
      paddingLeft: parseFloat(style?.paddingLeft),
      paddingRight: parseFloat(style?.paddingRight),
    },
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

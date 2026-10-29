import assert from "node:assert/strict";

// Serialized into the existing real-component browser captures. Hit testing
// complements geometry; an opaque, higher-z-index titlebar can cover an SVG
// even when the SVG fits entirely inside its own scroll rail.
export function measureWorkspaceTabIcon() {
  const tab = document.querySelector(
    '.auxiliary-heading [role="tab"][aria-selected="true"]',
  );
  const icon = tab?.querySelector("svg");
  const rail = tab?.closest('[role="tablist"]');
  if (!icon || !rail) return null;
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const bounds = rect(icon);
  const hit = document.elementFromPoint(
    (bounds.left + bounds.right) / 2,
    (bounds.top + bounds.bottom) / 2,
  );
  const styles = [];
  for (let element = icon; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    styles.push({
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      maskImage: style.maskImage,
    });
    if (element === rail) break;
  }
  return {
    id: tab.id,
    icon: bounds,
    rail: rect(rail),
    styles,
    hitInTab: tab.contains(hit),
    hit: hit ? `${hit.tagName}#${hit.id}` : null,
  };
}

export function assertWorkspaceTabIconVisible(m, reservedTitlebarRight) {
  assert.ok(m, "selected tab renders an SVG icon");
  assert.ok(m.icon.width > 0 && m.icon.height > 0, "tab icon has visible size");
  assert.ok(
    m.icon.left >= m.rail.left - 1 &&
      m.icon.right <= m.rail.right + 1 &&
      m.icon.top >= m.rail.top - 1 &&
      m.icon.bottom <= m.rail.bottom + 1,
    "selected tab icon is not clipped by the scroll rail",
  );
  assert.ok(
    m.styles.every(
      (style) =>
        style.display !== "none" &&
        style.visibility === "visible" &&
        Number(style.opacity) > 0 &&
        style.maskImage === "none",
    ),
    "selected tab icon and rail are visible without a masking layer",
  );
  if (reservedTitlebarRight !== undefined)
    assert.ok(
      m.rail.left >= reservedTitlebarRight - 1,
      "tab rail clears the full titlebar, not just its native controls",
    );
  assert.ok(
    m.hitInTab,
    "selected tab icon center is not covered by another layer",
  );
}

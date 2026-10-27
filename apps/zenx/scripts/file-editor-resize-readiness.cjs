/** Read-only native-fixture readiness, including ResizeObserver-derived bounds. */
exports.fileEditorResizeState = function fileEditorResizeState(document) {
  const panel = document.querySelector(".auxiliary-panel");
  const body = panel?.querySelector(".auxiliary-body");
  const separator = panel?.querySelector(".workspace-file-resizer");
  if (!panel || !body || !separator) return { ready: false };
  const bounds = body.getBoundingClientRect();
  const panelWidth = panel.getBoundingClientRect().width;
  const stacked =
    document.defaultView.getComputedStyle(body).flexDirection === "column";
  // Matches AuxiliaryPanel's measured split constraint, not a new product limit.
  const expectedMaximum = stacked
    ? Math.max(100, Math.min(300, bounds.height - 160))
    : Math.max(140, Math.min(360, bounds.width - 240));
  const orientation = separator.getAttribute("aria-orientation");
  const maximum = Number(separator.getAttribute("aria-valuemax"));
  const current = Number(separator.getAttribute("aria-valuenow"));
  return {
    ready:
      // Normal-motion transitions can match ResizeObserver in an intermediate
      // frame. Require the final pane width, not merely its last animated pixel.
      Math.abs(panelWidth - 600) < 0.01 &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      orientation === (stacked ? "horizontal" : "vertical") &&
      Number.isFinite(maximum) &&
      Math.abs(maximum - expectedMaximum) < 0.01,
    panelWidth,
    body: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    },
    stacked,
    orientation,
    maximum,
    expectedMaximum,
    current,
  };
};

/** Fail closed before generating even mouseDown if the native target is stale. */
exports.fileEditorResizeEvents = (state, handle, scrollerWidth, width) => {
  if (!state.ready || state.stacked)
    throw new Error(
      "File-navigation bounds are not ready for a horizontal native drag",
    );
  const end = { x: Math.round(handle.x + scrollerWidth - width), y: handle.y };
  return [
    { type: "mouseMove", ...handle },
    { type: "mouseDown", button: "left", clickCount: 1, ...handle },
    {
      type: "mouseMove",
      button: "left",
      modifiers: ["leftButtonDown"],
      ...end,
    },
    { type: "mouseUp", button: "left", clickCount: 1, ...end },
  ];
};

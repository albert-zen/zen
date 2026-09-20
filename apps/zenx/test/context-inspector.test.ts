import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextInspector } from "../src/renderer/src/context-inspector.js";
import { ContextUsageIndicator } from "../src/renderer/src/ThreadView.js";
import { projectContextInspection } from "../../../src/context-inspection.js";
import { projectModelUsage } from "../../../src/model-usage.js";
Object.assign(globalThis, { React });

test("inspector is absent by default and labels estimates and capability uncertainty", () => {
  const usage = projectModelUsage([]);
  assert.equal(
    renderToStaticMarkup(React.createElement(ContextInspector, { usage })),
    "",
  );
  const html = renderToStaticMarkup(
    React.createElement(ContextInspector, {
      usage: { ...usage, inspection: projectContextInspection([]) },
    }),
  );
  assert.match(html, /Projected messages · estimate/u);
  assert.match(html, /Loaded Skills.*unknown/u);
  assert.match(html, /not a capture/u);
  assert.match(html, /No saved compaction/u);
});

test("unknown model window still provides the experimental entry but defaults to hidden", () => {
  const context = projectModelUsage([]).context;
  assert.equal(
    renderToStaticMarkup(
      React.createElement(ContextUsageIndicator, { context }),
    ),
    "",
  );
  assert.match(
    renderToStaticMarkup(
      React.createElement(ContextUsageIndicator, { context, onInspect() {} }),
    ),
    /Inspect context/u,
  );
});

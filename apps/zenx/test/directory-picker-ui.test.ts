import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

test("directory picker exposes an accessible modal and explicit selection action", async () => {
  Object.assign(globalThis, { React });
  const { DirectoryPicker } =
    await import("../src/renderer/src/DirectoryPicker.js");
  const html = renderToStaticMarkup(
    React.createElement(DirectoryPicker, {
      onCancel: () => undefined,
      onSelect: () => undefined,
    }),
  );
  assert.match(html, /role="dialog"/u);
  assert.match(html, /aria-modal="true"/u);
  assert.match(html, /aria-label="Starting locations"/u);
  assert.match(html, /aria-label="Subfolders"/u);
  assert.match(html, /Reading folders/u);
  assert.match(html, /Add folder/u);
  assert.match(html, /disabled=""/u);
});

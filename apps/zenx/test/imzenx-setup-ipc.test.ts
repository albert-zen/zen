import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedImZenXSetupSender } from "../src/main/imzenx-setup-ipc.js";

test("secure IM setup rejects remote main frames, foreign windows, iframes and other same-origin pages", () => {
  const rendererUrl = "http://127.0.0.1:5173/";
  const allowed = { ownedWindow: true, mainFrame: true, url: rendererUrl };
  assert.equal(isTrustedImZenXSetupSender(allowed, rendererUrl), true);
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: `${rendererUrl}#settings` },
      rendererUrl,
    ),
    true,
  );
  for (const sender of [
    { ...allowed, ownedWindow: false },
    { ...allowed, mainFrame: false },
    { ...allowed, url: "https://example.com/" },
    { ...allowed, url: "http://127.0.0.1:5173/other.html" },
    { ...allowed, url: `${rendererUrl}?redirect=remote` },
    { ...allowed, url: "not-a-url" },
  ])
    assert.equal(isTrustedImZenXSetupSender(sender, rendererUrl), false);
  const file = "file:///app/renderer/index.html";
  assert.equal(
    isTrustedImZenXSetupSender({ ...allowed, url: file }, file),
    true,
  );
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: "file:///app/renderer/other.html" },
      file,
    ),
    false,
  );
});

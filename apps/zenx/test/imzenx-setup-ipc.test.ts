import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { format, pathToFileURL } from "node:url";
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
  const file = pathToFileURL(
    path.resolve("synthetic/renderer/index.html"),
  ).href;
  assert.equal(
    isTrustedImZenXSetupSender({ ...allowed, url: file }, file),
    true,
  );
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: new URL("other.html", file).href },
      file,
    ),
    false,
  );
});

test("packaged renderer accepts equivalent file-path encoding without relaxing its owner", () => {
  const filename = path.resolve(
    "synthetic",
    "RUNNER~1",
    "renderer",
    "index.html",
  );
  // These are the same two constructors used by Electron 43 loadFile and the
  // production expected-renderer guard. No file is opened or IPC dispatched.
  const loaded = new URL(
    format({ protocol: "file", slashes: true, pathname: filename }),
  ).href;
  const expected = pathToFileURL(filename).href;
  const allowed = { ownedWindow: true, mainFrame: true, url: loaded };
  assert.equal(isTrustedImZenXSetupSender(allowed, expected), true);
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: `${loaded}#settings` },
      expected,
    ),
    true,
  );
  for (const override of [{ ownedWindow: false }, { mainFrame: false }])
    assert.equal(
      isTrustedImZenXSetupSender({ ...allowed, ...override }, expected),
      false,
    );
});

test("Windows short-path encoding equivalence preserves path, query, host and protocol fences", () => {
  const expected = "file:///C:/Users/RUNNER%7E1/app/renderer/index.html";
  const allowed = { ownedWindow: true, mainFrame: true };
  for (const url of [
    "file:///C:/Users/RUNNER~1/app/renderer/index.html",
    "file:///C:/Users/%52UNNER%7e1/app/renderer/%69ndex.html",
  ])
    assert.equal(
      isTrustedImZenXSetupSender({ ...allowed, url }, expected),
      true,
      url,
    );
  for (const url of [
    "file:///C:/Users/RUNNER~1/app/renderer/other.html",
    "file:///C:/Users/RUNNER~1/app/renderer/index.html/",
    "file:///C:/Users/RUNNER~1/other-app/renderer/index.html",
    "file:///C:/Users/RUNNER~1/app//renderer/index.html",
    "file:///D:/Users/RUNNER~1/app/renderer/index.html",
    "file:///C:/Users/RUNNER~1/app/renderer/index.html.",
    "file:///C:/Users/RUNNER~1/app/renderer/index.html%20",
    "file:///C:/Users/RUNNER~1/app/renderer/index.html:stream",
    "file:///C:/Users/RUNNER%257E1/app/renderer/index.html",
    "file:///C:/Users/RUNNER~1/app%2Frenderer/index.html",
    "file:///C:/Users/RUNNER~1/app%5Crenderer/index.html",
    "file:///C:/Users/RUNNER~1/app/renderer/index.html?",
    "file:///C:/Users/RUNNER~1/app/renderer/index.html?redirect=remote",
    "file://foreign-host/C:/Users/RUNNER~1/app/renderer/index.html",
    "https://example.com/C:/Users/RUNNER~1/app/renderer/index.html",
  ])
    assert.equal(
      isTrustedImZenXSetupSender({ ...allowed, url }, expected),
      false,
      url,
    );
  assert.equal(
    isTrustedImZenXSetupSender(
      {
        ...allowed,
        url: "file:///C:/Users/RUNNER~1/app/renderer/index.html?mode=1",
      },
      `${expected}?mode=1`,
    ),
    true,
  );
  assert.equal(
    isTrustedImZenXSetupSender(
      {
        ...allowed,
        url: "file:///C:/Users/RUNNER~1/app/renderer/index.html?mode=%31",
      },
      `${expected}?mode=1`,
    ),
    false,
  );
});

test("file renderer comparison fails closed on malformed paths and does not expand filesystem aliases", () => {
  const allowed = { ownedWindow: true, mainFrame: true };
  for (const url of [
    "file:///app/%/index.html",
    "file:///app/%GG/index.html",
    "file:///app/%C0%AF/index.html",
    "file:///app/%FF/index.html",
    "file:///app/%ED%A0%80/index.html",
    "file:///app/%E2%82/index.html",
    "file:///app/%2f/index.html",
  ])
    assert.equal(
      isTrustedImZenXSetupSender({ ...allowed, url }, url),
      false,
      url,
    );
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: "file:///C:/Users/runneradmin/app/index.html" },
      "file:///C:/Users/RUNNER~1/app/index.html",
    ),
    false,
  );
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: "file:///C:/Users/runner~1/app/index.html" },
      "file:///C:/Users/RUNNER~1/app/index.html",
    ),
    false,
  );
});

test("development renderer keeps exact remote URL comparison", () => {
  const expected = "http://127.0.0.1:5173/RUNNER~1/index.html";
  const allowed = { ownedWindow: true, mainFrame: true };
  assert.equal(
    isTrustedImZenXSetupSender({ ...allowed, url: expected }, expected),
    true,
  );
  for (const url of [
    "http://127.0.0.1:5173/RUNNER%7E1/index.html",
    "https://127.0.0.1:5173/RUNNER~1/index.html",
    "http://127.0.0.1:5174/RUNNER~1/index.html",
    "file:///RUNNER~1/index.html",
    `${expected}?`,
  ])
    assert.equal(
      isTrustedImZenXSetupSender({ ...allowed, url }, expected),
      false,
      url,
    );
});

test("file URL path data never changes query or fragment identity", () => {
  const allowed = { ownedWindow: true, mainFrame: true };
  const expected =
    "file:///C:/app/question%3Fhash%23percent%25/index.html?one=1&two=2";
  assert.equal(
    isTrustedImZenXSetupSender(
      { ...allowed, url: expected.replace("%3F", "%3f") + "#panel" },
      expected,
    ),
    true,
  );
  for (const url of [
    expected.replace("%25", "%2525"),
    expected.replace("?one=1&two=2", "?two=2&one=1"),
    expected.replace("?one=1&two=2", "?one=%31&two=2"),
    expected.replace("%3F", "%253F"),
  ])
    assert.equal(
      isTrustedImZenXSetupSender({ ...allowed, url }, expected),
      false,
      url,
    );
  const valid = "file:///C:/app/index.html";
  for (const malformed of ["%", "%FF", "%2F"])
    assert.equal(
      isTrustedImZenXSetupSender(
        { ...allowed, url: valid },
        valid.replace("index", malformed),
      ),
      false,
    );
});

test(
  "Windows UNC authority and encoded backslash stay fenced",
  { skip: process.platform !== "win32" },
  () => {
    const allowed = { ownedWindow: true, mainFrame: true };
    const expected = "file://host/share/RUNNER%7E1/index.html";
    assert.equal(
      isTrustedImZenXSetupSender(
        { ...allowed, url: expected.replace("%7E", "~") },
        expected,
      ),
      true,
    );
    for (const url of [
      expected.replace("host", "other"),
      expected.replace("share", "other"),
      expected.replace("%7E", "%5C"),
    ])
      assert.equal(
        isTrustedImZenXSetupSender({ ...allowed, url }, expected),
        false,
        url,
      );
    const encodedSeparator = "file:///C:/app%5Crenderer/index.html";
    assert.equal(
      isTrustedImZenXSetupSender(
        { ...allowed, url: encodedSeparator },
        encodedSeparator,
      ),
      false,
    );
  },
);

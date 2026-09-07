import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { startupScreenHtml } from "../src/main/startup-screen.js";

test("startup screen is visible content with no scripts or IPC dependency", () => {
  const document = new JSDOM(startupScreenHtml()).window.document;
  assert.match(
    document.querySelector('[role="status"]')?.textContent ?? "",
    /Starting ZenX/u,
  );
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.match(
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content") ?? "",
    /default-src 'none'/u,
  );
});
test("startup failure renders the actual error as inert text", () => {
  const error = "<script>bad()</script> & unavailable";
  const document = new JSDOM(startupScreenHtml(error)).window.document;
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /<script>bad\(\)<\/script> & unavailable/u,
  );
  assert.equal(document.querySelectorAll("script").length, 0);
});

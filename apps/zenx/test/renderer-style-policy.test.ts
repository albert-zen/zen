import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  isExactRendererEntry,
  rendererHtmlWithStyleNonce,
} from "../src/main/renderer-style-policy.js";

const source = await readFile(
  new URL("../src/renderer/index.html", import.meta.url),
  "utf8",
);
const nonce = () => randomBytes(24).toString("base64");
test("renderer transform changes only the unique style source and adds one nonce meta", () => {
  const n = nonce(),
    actual = rendererHtmlWithStyleNonce(source, n);
  assert.equal(
    actual
      .replace(` 'nonce-${n}'`, "")
      .replace(`<meta name="zenx-style-nonce" content="${n}">`, ""),
    source,
  );
  assert.ok(!actual.includes("'unsafe-inline'"));
  assert.equal((actual.match(/name="zenx-style-nonce"/g) || []).length, 1);
  assert.notEqual(rendererHtmlWithStyleNonce(source, nonce()), actual);
});
test("malformed, duplicate, permissive or preauthorized templates fail closed", () => {
  for (const html of [
    source.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    source.replace("style-src 'self'", "style-src 'none'; style-src 'self'"),
    source.replace(
      "style-src 'self'",
      "style-src 'self'; style-src-elem 'self'",
    ),
    source.replace("Content-Security-Policy", "Not-CSP"),
    source + source,
    source + '<meta name="zenx-style-nonce" content="old">',
  ])
    assert.throws(() => rendererHtmlWithStyleNonce(html, nonce()));
  for (const n of ["", "'unsafe-inline'", "a".repeat(31), "a".repeat(33)])
    assert.throws(() => rendererHtmlWithStyleNonce(source, n));
});
test("only exact trusted renderer URL transforms; no aliases or adjacent paths", () => {
  const entry = "file:///app/renderer/index.html";
  assert.equal(isExactRendererEntry(entry, entry), true);
  for (const url of [
    "https://example.com/index.html",
    "file://host/app/renderer/index.html",
    "file:///app/renderer/other.html",
    entry + "?x=1",
    entry + "#x",
    "file:///app/renderer/%69ndex.html",
    "file:///app/renderer/a/../index.html",
  ])
    assert.equal(isExactRendererEntry(url, entry), false);
});
test("all existing CodeMirror construction sites consume the document nonce", async () => {
  for (const name of [
    "InlineComposerEditor",
    "InlineMarkdownEditor",
    "SourceEditor",
  ]) {
    const text = await readFile(
      new URL(`../src/renderer/src/${name}.tsx`, import.meta.url),
      "utf8",
    );
    assert.match(text, /extensions:\s*\[\s*editorStyleNonce\(\)/u);
  }
});

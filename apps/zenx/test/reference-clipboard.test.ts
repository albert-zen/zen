import assert from "node:assert/strict";
import test from "node:test";
import {
  referenceClipboard,
  readReferenceClipboard,
  REFERENCE_CLIPBOARD_TYPE,
} from "../src/renderer/src/reference-clipboard.js";
const reference = {
  kind: "message" as const,
  name: "Source",
  cwd: "/synthetic",
  threadId: "main-thread",
  id: "selected-message",
  excerpt: '  exact\n\n"quote"\t😀  ',
  position: 2,
};
test("clipboard carries exact provenance only in custom metadata and fails closed on mismatch or malformed metadata", () => {
  const value = referenceClipboard("a \uFFFC z", [reference]);
  assert.equal(value.plain, "a " + reference.excerpt + " z");
  assert.ok(!value.plain.includes(reference.threadId));
  const data = (structured: string, plain = value.plain) => ({
    getData: (type: string) =>
      type === REFERENCE_CLIPBOARD_TYPE
        ? structured
        : type === "text/plain"
          ? plain
          : "",
  });
  assert.deepEqual(readReferenceClipboard(data(value.structured)), {
    text: "a \uFFFC z",
    references: [reference],
  });
  for (const raw of [
    "",
    value.structured.slice(0, -1),
    value.structured.replace('"kind":"message"', '"kind": "message"'),
    value.structured.replace('"zenx-clipboard"', '"other"'),
  ])
    assert.equal(readReferenceClipboard(data(raw)), null);
  assert.equal(
    readReferenceClipboard(data(value.structured, "ordinary external text")),
    null,
  );
  assert.equal(readReferenceClipboard(null), null);
});

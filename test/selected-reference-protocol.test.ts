import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSentReferenceV3 } from "../src/selected-reference-protocol.js";
import {
  parseSentReferenceContent,
  referenceMessage,
} from "../apps/zenx/src/renderer/src/reference-draft.js";

test("shared v3 codec preserves the existing five-source captured Composer fixture byte-for-byte", async () => {
  const fixture = JSON.parse(
    await readFile(
      "apps/zenx/docs/reference-context/v3/fixture-metadata.json",
      "utf8",
    ),
  );
  assert.equal(
    referenceMessage(fixture.text, fixture.references, fixture.clientId),
    fixture.payload,
  );
  const parsed = parseSentReferenceV3(fixture.payload, fixture.clientId);
  assert.deepEqual(
    parsed,
    parseSentReferenceContent(fixture.payload, fixture.clientId),
  );
  assert.deepEqual(parsed, {
    text: fixture.text,
    references: fixture.references,
  });
  assert.equal(
    parseSentReferenceV3(fixture.payload, "different-submission"),
    null,
  );
  assert.equal(
    parseSentReferenceV3(
      `\`\`\`text\n${fixture.payload}\n\`\`\``,
      fixture.clientId,
    ),
    null,
  );
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { fileEditorDiagnosticScope } = createRequire(import.meta.url)(
  "../scripts/file-editor-diagnostic-scope.cjs",
);
test("native editor diagnostic defaults to all and requires a known explicit contract", () => {
  assert.equal(fileEditorDiagnosticScope([]), "all");
  for (const scope of ["all", "scroll-security", "end-navigation"])
    assert.equal(fileEditorDiagnosticScope([`--scope=${scope}`]), scope);
  for (const args of [
    ["scroll-security"],
    ["--scope="],
    ["--scope=unknown"],
    ["--scope=scroll-security", "ignored"],
  ])
    assert.throws(() => fileEditorDiagnosticScope(args));
});

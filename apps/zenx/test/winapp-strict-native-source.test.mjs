import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patch = readFileSync(
  new URL(
    "../../../vendor/winapp-0.3.1/disable-auto-set-focus.patch",
    import.meta.url,
  ),
  "utf8",
);
const added = patch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");

test("private strict entry point bypasses stock selector commands", () => {
  assert.match(added, /args\[0\] == "--zenx-uia-strict"/);
  assert.match(added, /ZenXStrictUiaCommand\.Run/);
  assert.match(added, /zenx-winapp-0\.3\.1-af0\.2/);
  assert.match(added, /contractVersion/);
});

test("strict mutations dispatch exactly one requested pattern on the verified element", () => {
  assert.equal((added.match(/\.Invoke\(\)/g) ?? []).length, 1);
  assert.equal((added.match(/\.SetValue\(/g) ?? []).length, 1);
  assert.doesNotMatch(
    added,
    /FindFirst\(|ResolveComElement\(|FindInvokableAncestor\(|SetForegroundWindow\(|\bSetFocus\(|SendInput\(|ShowWindow\(|RangeValuePattern|TogglePattern|SelectionItemPattern|ExpandCollapsePattern/,
  );
  assert.match(added, /FindAll\(TreeScope\.TreeScope_Subtree/);
  assert.match(added, /get_Length\(\) != 1/);
  assert.match(added, /CompareElements\(/);
  assert.match(added, /GetAncestor\(/);
  assert.match(added, /IsChild\(/);
  assert.match(added, /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(added, /SequenceEqual/);
});

test("strict serialization is bounded, reflection-free and preserves uncertain outcomes", () => {
  assert.match(added, /MaxRequestBytes = 256 \* 1024/);
  assert.match(added, /MaxValueLength = 4000/);
  assert.match(added, /JsonDocument\.Parse/);
  assert.match(added, /Utf8JsonWriter/);
  assert.doesNotMatch(added, /JsonSerializer\./);
  assert.match(added, /dispatched \? "unknown" : "not_dispatched"/);
  assert.match(added, /readback_mismatch/);
  assert.match(added, /StringComparison\.Ordinal/);
  assert.match(added, /SafeArrayDestroy/);
});

test("the final validation repeats uniqueness and never truncates value readback", () => {
  const revalidate = added.slice(
    added.indexOf("private static void Revalidate("),
    added.indexOf("private static Root CaptureRoot("),
  );
  assert.match(revalidate, /UniqueNativeElement/);
  assert.match(revalidate, /CompareElements\(element, stillUnique\)/);
  assert.match(revalidate, /SameRoot/);
  assert.match(revalidate, /SameControl/);
  assert.match(revalidate, /VerifyNativeAncestry/);
  assert.match(revalidate, /VerifyUiaAncestry/);
  assert.equal(
    (revalidate.match(/service\.ZenXAutoSetFocus/g) ?? []).length,
    2,
  );
  assert.match(
    added,
    /ReadBstr\(valuePattern!\.get_CurrentValue\(\), MaxValueLength\)/,
  );
  assert.match(added, /Require\(bstr\.Length <= limit/);
  assert.match(added, /Marshal\.FreeBSTR/);
  assert.doesNotMatch(
    added,
    /Substring\(|\.Take\(|\.Trim\(|ToLower\(|ToUpper\(/,
  );
});

test("request objects reject unknown, duplicate and missing fields before dispatch", () => {
  assert.match(added, /unseen\.Remove\(property\.Name\)/);
  assert.match(added, /unseen\.Count == 0/);
  assert.match(
    added,
    /valuePattern == \(readOnly\.ValueKind != JsonValueKind\.Null\)/,
  );
  assert.match(added, /char\.IsHighSurrogate/);
  assert.match(added, /char\.IsLowSurrogate/);
  assert.match(added, /MaxDepth = 8/);
  assert.ok(
    added.indexOf("var request = ParseRequest();") <
      added.indexOf("var service = resolveService();"),
  );
});

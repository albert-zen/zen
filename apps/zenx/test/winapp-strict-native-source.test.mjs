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

test("new native source matches the pinned upstream IDE0073 header template", () => {
  // src/winapp-CLI/.editorconfig at c8ada4a403c43b96780b87abc454cba51f649c60.
  const strictPatch = patch.split(
    "+++ b/src/winapp-CLI/WinApp.Cli/Services/ZenXStrictUiaCommand.cs\n",
  )[1];
  assert.ok(strictPatch);
  const header = strictPatch
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .slice(0, 2)
    .map((line) => line.slice(1))
    .join("\n");
  assert.equal(
    header,
    "// Copyright (c) Microsoft Corporation and Contributors. All rights reserved.\n" +
      "// Licensed under the MIT License.",
  );
});

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

// These are source-contract guards. Actual COM/provider behavior is established
// separately by the packaged Windows fixture, not by these text assertions.
test("only a fully validated empty virtual RuntimeId can remain a read-only row", () => {
  const source = added.slice(
    added.indexOf("private static unsafe int[] RuntimeId("),
    added.indexOf("private static Refusal RuntimeRefusal("),
  );
  const exception =
    "if (length == 0 && context == RuntimeReadContext.WalkVirtual) { return []; }";
  assert.ok(source.includes(exception));
  for (const guard of [
    "if (array == null)",
    "if (dimensions != 1)",
    "if (elementSize != sizeof(int))",
    "if (array->pvData == null)",
    "var length = array->rgsabound[0].cElements;",
  ]) {
    assert.ok(source.indexOf(guard) >= 0);
    assert.ok(source.indexOf(guard) < source.indexOf(exception));
  }
  assert.ok(
    source.indexOf(exception) < source.indexOf("if (length is 0 or > 64)"),
  );
  assert.ok(
    source.indexOf("if (length is 0 or > 64)") <
      source.indexOf("new ReadOnlySpan<int>"),
  );
  assert.match(source, /finally \{ PInvoke\.SafeArrayDestroy\(array\); \}/);
  assert.equal((source.match(/return \[\];/g) ?? []).length, 1);
  assert.match(
    added,
    /runtimeContext == RuntimeReadContext\.WalkChild && hwnd\.IsNull/,
  );
});

test("anonymous virtual visits retain every traversal budget and nonempty identity uniqueness", () => {
  const walk = added.slice(
    added.indexOf("private static void Walk("),
    added.indexOf("private static Control CaptureControl("),
  );
  assert.match(
    walk,
    /\+\+nodes <= MaxNodes && depth <= MaxDepth && controls\.Count < MaxControls/,
  );
  assert.ok(walk.indexOf("++nodes") < walk.indexOf("CaptureControl("));
  assert.match(walk, /control\.RuntimeId\.Length == 0 \|\| visited\.Add/);
  assert.match(walk, /"duplicate_runtime_identity"/);
  assert.match(walk, /controls\.Add\(control\)/);
  assert.match(
    walk,
    /Walk\(walker, child, depth \+ 1, controls, visited, ref nodes\)/,
  );
  assert.match(walk, /walker\.GetNextSiblingElement\(child\)/);
  assert.doesNotMatch(walk, /catch|continue|return/);
});

test("empty native/root action identities remain invalid and HWND0 stops before UIA access", () => {
  const parseRoot = added.slice(
    added.indexOf("private static Root ParseRoot("),
    added.indexOf("private static Control ParseControl("),
  );
  assert.match(parseRoot, /ParseRuntimeId\(element\)/);
  assert.doesNotMatch(parseRoot, /allowEmpty/);
  assert.match(added, /ParseRuntimeId\(element, allowEmpty: hwnd == "0"\)/);
  assert.match(
    added,
    /ParseRuntimeId\(JsonElement element, bool allowEmpty = false\)/,
  );
  assert.match(
    added,
    /array\.GetArrayLength\(\) <= 64 && \(allowEmpty \|\| array\.GetArrayLength\(\) > 0\)/,
  );
  const mutate = added.slice(
    added.indexOf("private static string? Mutate("),
    added.indexOf("private static IUIAutomationElement UniqueNativeElement("),
  );
  assert.ok(
    mutate.indexOf("Handle(expected.Hwnd, false)") <
      mutate.indexOf("automation.ElementFromHandle("),
  );
  assert.equal((mutate.match(/\.Invoke\(\)/g) ?? []).length, 1);
  assert.equal((mutate.match(/\.SetValue\(/g) ?? []).length, 1);
});

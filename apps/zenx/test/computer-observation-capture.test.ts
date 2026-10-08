import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputerObservationLedger,
  uniqueComputerCaptureEntries,
} from "../src/main/capabilities/computer-provider.js";
import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";
import { PeekabooComputerBackend } from "../src/main/capabilities/peekaboo-computer-provider.js";
import { WinAppCliComputerBackend } from "../src/main/capabilities/windows-computer-provider.js";

const target = { pid: 42, applicationId: "Fixture", windowTitle: "Window" };

test("Computer capture fingerprints grant continuity only to unique exact entries", () => {
  const entries = uniqueComputerCaptureEntries(
    ["first", "duplicate", "same label elsewhere", "changed"],
    ["exact-a", "exact-a", "exact-b", "exact-c"],
  );
  assert.deepEqual(entries, [
    { value: "first" },
    { value: "duplicate" },
    { value: "same label elsewhere", identity: "exact-b" },
    { value: "changed", identity: "exact-c" },
  ]);
});

test("Computer ledger capture validation expires on replacement, consumption and close", () => {
  const ledger = new ComputerObservationLedger();
  const fingerprint = { role: "button", actions: ["press"] as const };
  const observe = () =>
    ledger.observe(
      "window",
      [{ ...fingerprint, actions: ["press"] }],
      "native-1",
    );
  const first = observe();
  assert.doesNotThrow(() =>
    ledger.assertCurrent("window", first.observationId),
  );
  assert.throws(
    () => ledger.assertCurrent("other", first.observationId),
    /stale/u,
  );
  const second = observe();
  assert.throws(
    () => ledger.assertCurrent("window", first.observationId),
    /stale/u,
  );
  assert.throws(
    () => ledger.consume("window", second.selectors[0]!, "press", "native-2"),
    /another target/u,
  );
  ledger.consume("window", second.selectors[0]!, "press", "native-1");
  assert.throws(
    () => ledger.assertCurrent("window", second.observationId),
    /consumed/u,
  );
  const third = observe();
  ledger.clear();
  assert.throws(
    () => ledger.assertCurrent("window", third.observationId),
    /unknown/u,
  );
});

test("WinApp capture retains searchable tail controls with fresh actionable selectors", async () => {
  const fixture = winAppFixture(
    Array.from({ length: 40 }, (_, index) => winAppElement(index)),
  );
  const first = await fixture.backend.inspect(target);
  const capture = first[OBSERVATION_CAPTURE]!;
  assert.equal(first.controls.length, 32);
  assert.equal(capture.entries.length, 40);
  assert.deepEqual(
    capture.entries.slice(0, 32).map(({ value }) => value),
    first.controls,
  );
  assert.strictEqual(capture.entries[0]!.value, first.controls[0]);
  assert.equal(capture.coverage.sourceComplete, true);
  assert.deepEqual(capture.coverage.reasons, []);
  assert.doesNotMatch(JSON.stringify(first), /provider-selector/u);
  assert.doesNotThrow(() => capture.assertCurrent!());

  const second = await fixture.backend.inspect(target);
  const next = second[OBSERVATION_CAPTURE]!;
  assert.equal(next.scopeKey, capture.scopeKey);
  assert.deepEqual(
    next.entries.map(({ identity }) => identity),
    capture.entries.map(({ identity }) => identity),
  );
  assert.notEqual(
    next.entries[39]!.value.selector.targetId,
    capture.entries[39]!.value.selector.targetId,
  );
  assert.throws(() => capture.assertCurrent!(), /stale/u);
  await fixture.backend.press(target, next.entries[39]!.value.selector);
  assert.equal(
    fixture.calls.find((args) => args[1] === "invoke")?.[2],
    "provider-selector-39",
  );
  assert.throws(() => next.assertCurrent!(), /consumed/u);
  await fixture.backend.close();
});

test("WinApp exact capture identity preserves full fields and rejects duplicate fingerprints", async () => {
  const common = "x".repeat(256);
  const duplicate = winAppElement(1);
  const fixture = winAppFixture([
    duplicate,
    { ...duplicate },
    { ...winAppElement(2), name: `${common}first` },
    { ...winAppElement(2), name: `${common}second` },
  ]);
  const captured = (await fixture.backend.inspect(target))[
    OBSERVATION_CAPTURE
  ]!;
  assert.equal(captured.entries[0]!.identity, undefined);
  assert.equal(captured.entries[1]!.identity, undefined);
  assert.equal(
    captured.entries[2]!.value.title,
    captured.entries[3]!.value.title,
  );
  assert.notEqual(captured.entries[2]!.identity, captured.entries[3]!.identity);
  await fixture.backend.close();
});

test("WinApp capture distinguishes native visit and depth omissions from public selection", async () => {
  const fixture = winAppFixture(
    Array.from({ length: 513 }, (_, index) => winAppElement(index)),
  );
  fixture.state.elements[0]!.hasMoreChildren = true;
  const capture = (await fixture.backend.inspect(target))[OBSERVATION_CAPTURE]!;
  assert.equal(capture.entries.length, 512);
  assert.equal(capture.coverage.sourceComplete, false);
  assert.equal(capture.coverage.itemTotal, undefined);
  assert.ok(capture.coverage.reasons.includes("visit_limit"));
  assert.ok(capture.coverage.reasons.includes("native_depth_limit"));
  await fixture.backend.close();
  assert.throws(() => capture.assertCurrent!(), /unknown/u);
});

test("WinApp action rejects same-title replacement HWND before invoking", async () => {
  const fixture = winAppFixture([winAppElement(1)]);
  const inspection = await fixture.backend.inspect(target);
  fixture.state.hwnd = "9002";
  await assert.rejects(
    fixture.backend.press(target, inspection.controls[0]!.selector),
    /another target/u,
  );
  assert.equal(
    fixture.calls.some((args) => args[1] === "invoke"),
    false,
  );
  const replacement = await fixture.backend.inspect(target);
  assert.notEqual(
    replacement[OBSERVATION_CAPTURE]!.scopeKey,
    inspection[OBSERVATION_CAPTURE]!.scopeKey,
  );
  const otherProvider = winAppFixture([winAppElement(1)]);
  assert.notEqual(
    (await otherProvider.backend.inspect(target))[OBSERVATION_CAPTURE]!
      .scopeKey,
    inspection[OBSERVATION_CAPTURE]!.scopeKey,
  );
  await fixture.backend.close();
  await otherProvider.backend.close();
});

test("Peekaboo capture retains tail controls, duplicate ambiguity and unknown native completeness", async () => {
  const fixture = peekabooFixture(
    Array.from({ length: 40 }, (_, index) => peekabooElement(index)),
  );
  fixture.state.elements[0] = { ...peekabooElement(1), id: "another-id" };
  const first = await fixture.backend.inspect(target);
  const capture = first[OBSERVATION_CAPTURE]!;
  assert.equal(capture.entries.length, 40);
  assert.equal(first.controls.length, 32);
  assert.deepEqual(
    capture.entries.slice(0, 32).map(({ value }) => value),
    first.controls,
  );
  assert.equal(capture.entries[0]!.identity, undefined);
  assert.equal(capture.entries[1]!.identity, undefined);
  assert.equal(capture.coverage.sourceComplete, null);
  assert.equal(capture.coverage.itemTotal, undefined);
  assert.deepEqual(capture.coverage.reasons, ["native_completeness_unknown"]);
  const next = (await fixture.backend.inspect(target))[OBSERVATION_CAPTURE]!;
  assert.equal(next.scopeKey, capture.scopeKey);
  assert.equal(next.entries[39]!.identity, capture.entries[39]!.identity);
  assert.notEqual(
    next.entries[39]!.value.selector.targetId,
    capture.entries[39]!.value.selector.targetId,
  );
  assert.throws(() => capture.assertCurrent!(), /stale/u);
  await fixture.backend.press(target, next.entries[39]!.value.selector);
  const click = fixture.calls.find((args) => args[0] === "click")!;
  assert.equal(click[click.indexOf("--on") + 1], "element-39");
  assert.equal(click[click.indexOf("--snapshot") + 1], "snapshot-3");
  assert.throws(() => next.assertCurrent!(), /consumed/u);
  await fixture.backend.close();
});

test("Peekaboo capture reports native and defensive output limits", async () => {
  const fixture = peekabooFixture(
    Array.from({ length: 129 }, (_, index) => peekabooElement(index)),
  );
  fixture.state.truncation = { limit: 128 };
  const capture = (await fixture.backend.inspect(target))[OBSERVATION_CAPTURE]!;
  assert.equal(capture.entries.length, 128);
  assert.equal(capture.coverage.sourceComplete, false);
  assert.deepEqual(capture.coverage.reasons, [
    "native_capture_truncation",
    "native_output_limit",
  ]);
  await fixture.backend.close();
  assert.throws(() => capture.assertCurrent!(), /unknown/u);
});

test("Peekaboo cleans fresh snapshots when revalidation fails", async () => {
  const fixture = peekabooFixture([peekabooElement(1)]);
  const inspection = await fixture.backend.inspect(target);
  fixture.state.elements[0]!.label = "changed";
  await assert.rejects(
    fixture.backend.press(target, inspection.controls[0]!.selector),
    /identity changed/u,
  );
  assert.equal(
    fixture.calls.some((args) => args[0] === "click"),
    false,
  );
  assert.deepEqual(
    fixture.calls
      .filter((args) => args[0] === "clean")
      .map((args) => args[2])
      .sort(),
    ["snapshot-1", "snapshot-2"],
  );
  await fixture.backend.close();
});

function winAppElement(index: number) {
  return {
    selector: `provider-selector-${index}`,
    type: "Button",
    name: `Button ${index}`,
    automationId: `button-${index}`,
    isInvokable: true,
    isEnabled: true,
    isOffscreen: false,
    x: 10,
    y: index,
    width: 40,
    height: 20,
    hasMoreChildren: false,
  };
}

function winAppFixture(elements: ReturnType<typeof winAppElement>[]) {
  const state = { hwnd: "9001", elements };
  const calls: string[][] = [];
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner: {
      async run(_executable, args) {
        calls.push([...args]);
        const window = {
          hwnd: state.hwnd,
          processId: 42,
          processName: "Fixture",
          title: "Window",
          width: 800,
          height: 600,
        };
        const result =
          args[1] === "list-windows"
            ? [window]
            : args[1] === "inspect"
              ? { windows: [{ hwnd: state.hwnd, elements: state.elements }] }
              : { hwnd: state.hwnd };
        return { stdout: JSON.stringify(result), stderr: "" };
      },
    },
  });
  return { backend, state, calls };
}

function peekabooElement(index: number) {
  return {
    id: `element-${index}`,
    role: "AXButton",
    label: `Button ${index}`,
    is_actionable: true,
  };
}

function peekabooFixture(elements: ReturnType<typeof peekabooElement>[]) {
  const state: {
    elements: ReturnType<typeof peekabooElement>[];
    truncation?: object;
  } = { elements };
  const calls: string[][] = [];
  let snapshot = 0;
  const backend = new PeekabooComputerBackend({
    executable: "/fixture/peekaboo",
    runner: {
      async run(_executable, args) {
        calls.push([...args]);
        const data =
          args[0] === "see"
            ? {
                snapshot_id: `snapshot-${++snapshot}`,
                application_name: "Fixture",
                window_title: "Window",
                ui_elements: state.elements,
                truncation: state.truncation,
              }
            : {};
        return { stdout: JSON.stringify({ success: true, data }), stderr: "" };
      },
    },
  });
  return { backend, state, calls };
}

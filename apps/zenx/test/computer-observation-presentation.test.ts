import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputerZenXCapabilityPackage,
  type ComputerControlSelector,
  type ComputerInspection,
  type ComputerTarget,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";

type Control = ComputerInspection["controls"][number];
type SceneControl = Omit<Control, "selector">;
interface InspectionView {
  observationId: string;
  controls?: Control[];
  controlChanges?: {
    added: Control[];
    updated: Control[];
    removedFromView: string[];
    order?: string[];
  };
  nextCursor?: string;
  observation: {
    format: "full" | "diff";
    actionObservationId?: string;
    baseObservationId?: string;
    resetReason?: string;
    continuation?: boolean;
    identityKind: string;
    capturedAt: string;
    unchanged?: boolean;
  };
  coverage: {
    sourceComplete: boolean | null;
    reasons: string[];
    complete: boolean;
    items: {
      offset: number;
      returned: number;
      captured: number;
      hasMore: boolean;
    };
  };
}

const target: ComputerTarget = { pid: 42, windowTitle: "Window" };
const otherTarget: ComputerTarget = { pid: 42, windowTitle: "Other Window" };

test("Computer presentation rejects another thread's copied observation, control and cursor", async (t) => {
  const fixture = createFixture(40);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const selected = first.controls![0]!.selector;
  assert.ok(first.nextCursor);
  await assert.rejects(
    fixture.invoke("computer_press", "thread-b", {
      target,
      control: selected,
      threadId: "thread-a",
    }),
    /unavailable|another owner/u,
  );
  await assert.rejects(
    fixture.inspect("thread-b", { cursor: first.nextCursor }),
    /unavailable|another owner/u,
  );
  assert.equal(fixture.backend.actions.length, 0);
  assert.equal(fixture.backend.inspections, 1);

  const second = await fixture.inspect("thread-b");
  await assert.rejects(
    fixture.invoke("computer_press", "thread-b", { target, control: selected }),
    /stale|another owner/u,
  );
  await assert.rejects(
    fixture.invoke("computer_press", "thread-b", {
      target,
      control: {
        observationId: second.observationId,
        targetId: selected.targetId,
      },
    }),
    /not returned|unknown/u,
  );
  await assert.rejects(
    fixture.inspect("thread-b", { cursor: first.nextCursor }),
    /unknown|another owner/u,
  );
  await assert.rejects(
    fixture.inspect("thread-a", { cursor: first.nextCursor }),
    /backend capture replaced/u,
  );
  assert.equal(fixture.backend.actions.length, 0);
  assert.notEqual(second.observationId, first.observationId);
});

test("Computer presentation retains exact fingerprint references but forwards fresh raw action selectors", async (t) => {
  const fixture = createFixture(12);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const second = await fixture.inspect("thread-a");
  const before = first.controls![0]!.selector;
  const current = second.controls![0]!.selector;
  assert.notEqual(current.observationId, before.observationId);
  assert.equal(current.targetId, before.targetId);
  assert.notEqual(
    fixture.backend.lastCapture[0]!.selector.targetId,
    current.targetId,
  );
  await assert.rejects(
    fixture.invoke("computer_press", "thread-a", { target, control: before }),
    /stale/u,
  );
  assert.equal(fixture.backend.actions.length, 0);
  const result = (await fixture.invoke("computer_press", "thread-a", {
    target,
    control: current,
  })) as { control: ComputerControlSelector };
  assert.deepEqual(result.control, current);
  assert.deepEqual(
    fixture.backend.actions[0]!.control,
    fixture.backend.lastCapture[0]!.selector,
  );
});

test("Computer diffs reconstruct exact full controls and refresh retained action observation IDs", async (t) => {
  const fixture = createFixture(16);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const original = structuredClone(first.controls!);
  const oldScene = fixture.backend.scene;
  fixture.backend.scene = [
    oldScene[5]!,
    { ...oldScene[0]!, title: "A genuinely changed fingerprint" },
    ...oldScene.slice(1, 5),
    ...oldScene.slice(6, 15),
    sceneControl(99),
  ];
  const delta = await fixture.inspect("thread-a", {
    baseObservationId: first.observationId,
  });
  assert.equal(delta.observation.format, "diff");
  assert.equal(
    delta.observation.identityKind,
    "exact-fingerprint-presentation",
  );
  assert.equal(delta.observation.baseObservationId, first.observationId);
  assert.equal(delta.observation.actionObservationId, delta.observationId);
  assert.equal(delta.controls, undefined);
  assert.ok(delta.controlChanges);
  assert.ok(delta.controlChanges.order);
  const reconstructed = applyControlDiff(original, delta);
  assert.deepEqual(
    reconstructed.map(({ selector: _selector, ...control }) => control),
    fixture.backend.scene,
  );
  assert.ok(
    reconstructed.every(
      ({ selector }) =>
        selector.observationId === delta.observation.actionObservationId,
    ),
  );

  const retained = reconstructed.find(
    ({ title }) => title === oldScene[5]!.title,
  )!;
  const oldRetained = original.find(({ title }) => title === retained.title)!;
  assert.equal(retained.selector.targetId, oldRetained.selector.targetId);
  await assert.rejects(
    fixture.invoke("computer_press", "thread-a", {
      target,
      control: oldRetained.selector,
    }),
    /stale/u,
  );
  await fixture.invoke("computer_set_value", "thread-a", {
    target,
    control: retained.selector,
    value: "reviewed text",
  });
  assert.equal(
    fixture.backend.actions[0]!.control.observationId,
    delta.observationId,
  );
  assert.equal(
    fixture.backend.actions[0]!.control.targetId,
    fixture.backend.lastCapture[0]!.selector.targetId,
  );

  const full = await fixture.inspect("thread-a", { full: true });
  assert.equal(full.observation.format, "full");
  assert.deepEqual(
    reconstructed.map((control) => ({
      ...control,
      selector: { ...control.selector, observationId: full.observationId },
    })),
    full.controls,
  );
});

test("Computer unchanged diffs renew action observation identity without resending all controls", async (t) => {
  const fixture = createFixture(16);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const delta = await fixture.inspect("thread-a", {
    baseObservationId: first.observationId,
  });
  assert.equal(delta.observation.format, "diff");
  assert.equal(delta.observation.unchanged, true);
  assert.deepEqual(delta.controlChanges, {
    added: [],
    updated: [],
    removedFromView: [],
  });
  assert.notEqual(delta.observation.actionObservationId, first.observationId);
  const retained = applyControlDiff(first.controls!, delta)[0]!;
  await fixture.invoke("computer_press", "thread-a", {
    target,
    control: retained.selector,
  });
  assert.deepEqual(
    fixture.backend.actions[0]!.control,
    fixture.backend.lastCapture[0]!.selector,
  );
});

test("Computer cursor reads reach every retained control without recapture or completeness inflation", async (t) => {
  const fixture = createFixture(70, false);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const pages = [first];
  await assert.rejects(
    fixture.invoke("computer_press", "thread-a", {
      target,
      control: fixture.backend.lastCapture[69]!.selector,
    }),
    /not returned/u,
  );
  assert.equal(fixture.backend.actions.length, 0);
  let page = first;
  while (page.nextCursor !== undefined) {
    page = await fixture.inspect("thread-a", { cursor: page.nextCursor });
    pages.push(page);
  }
  assert.deepEqual(
    pages.map(({ controls }) => controls!.length),
    [32, 32, 6],
  );
  assert.equal(fixture.backend.inspections, 1);
  assert.deepEqual(
    pages.flatMap(({ controls }) => controls!.map(({ title }) => title)),
    fixture.backend.scene.map(({ title }) => title),
  );
  assert.ok(
    pages.every((result) => result.observationId === first.observationId),
  );
  assert.ok(
    pages.every(
      (result) =>
        result.observation.capturedAt === first.observation.capturedAt,
    ),
  );
  assert.ok(
    pages.every(
      (result) =>
        result.coverage.sourceComplete === false &&
        result.coverage.complete === false,
    ),
  );
  assert.ok(
    pages.every((result) =>
      result.coverage.reasons.includes("native_depth_limit"),
    ),
  );
  assert.equal(page.coverage.items.hasMore, false);
  const repeated = await fixture.inspect("thread-a", {
    cursor: first.nextCursor,
  });
  assert.deepEqual(repeated, pages[1]);
  await fixture.invoke("computer_press", "thread-a", {
    target,
    control: page.controls![5]!.selector,
  });
  assert.deepEqual(
    fixture.backend.actions[0]!.control,
    fixture.backend.lastCapture[69]!.selector,
  );
});

test("Computer mutation invalidates all issued cursors and actions for that capture", async (t) => {
  const fixture = createFixture(70);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const second = await fixture.inspect("thread-a", {
    cursor: first.nextCursor,
  });
  assert.ok(first.nextCursor);
  assert.ok(second.nextCursor);
  await fixture.invoke("computer_press", "thread-a", {
    target,
    control: second.controls![0]!.selector,
  });
  for (const cursor of [first.nextCursor, second.nextCursor]) {
    await assert.rejects(
      fixture.inspect("thread-a", { cursor }),
      /consumed|unavailable/u,
    );
  }
  await assert.rejects(
    fixture.invoke("computer_press", "thread-a", {
      target,
      control: first.controls![0]!.selector,
    }),
    /consumed|unavailable/u,
  );
  assert.equal(fixture.backend.inspections, 1);
  assert.equal(fixture.backend.actions.length, 1);
});

test("Computer foreground input invalidates captures across trusted threads and targets", async (t) => {
  const fixture = createFixture(40);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const second = await fixture.inspect("thread-b", { target: otherTarget });
  await fixture.invoke("computer_foreground_key_press", "thread-a", {
    key: "tab",
  });
  assert.equal(fixture.backend.foregroundActions, 1);
  await assert.rejects(
    fixture.inspect("thread-a", { cursor: first.nextCursor }),
    /consumed|unavailable/u,
  );
  await assert.rejects(
    fixture.inspect("thread-b", {
      target: otherTarget,
      cursor: second.nextCursor,
    }),
    /consumed|unavailable/u,
  );
  await assert.rejects(
    fixture.invoke("computer_press", "thread-b", {
      target: otherTarget,
      control: second.controls![0]!.selector,
    }),
    /consumed|unavailable/u,
  );
  assert.equal(fixture.backend.actions.length, 0);
});

test("Computer missing, expired or deliberately omitted diff bases produce self-contained full views", async (t) => {
  const fixture = createFixture(40);
  t.after(() => fixture.capability.close());
  const first = await fixture.inspect("thread-a");
  const missing = await fixture.inspect("thread-a", {
    baseObservationId: "missing-observation",
  });
  assert.equal(missing.observation.format, "full");
  assert.equal(missing.observation.resetReason, "base-unavailable");
  assert.equal(missing.controls!.length, 32);
  const realNow = Date.now();
  t.mock.method(Date, "now", () => realNow + 5 * 60_000 + 1);
  await assert.rejects(
    fixture.inspect("thread-a", { cursor: missing.nextCursor }),
    /expired|unavailable/u,
  );
  const expired = await fixture.inspect("thread-a", {
    baseObservationId: missing.observationId,
  });
  assert.equal(expired.observation.format, "full");
  assert.equal(expired.observation.resetReason, "base-unavailable");
  assert.equal(expired.controls!.length, 32);
  const omitted = await fixture.inspect("thread-a");
  assert.equal(omitted.observation.format, "full");
  assert.equal(omitted.controls!.length, 32);
  assert.notEqual(omitted.observationId, first.observationId);
});

test("Computer trusted threads require captured references while threadless legacy calls stay narrowly supported", async (t) => {
  const fixture = createFixture(4);
  t.after(() => fixture.capability.close());
  const direct = await fixture.backend.inspect(target);
  await assert.rejects(
    fixture.invoke("computer_press", "thread-a", {
      target,
      control: direct.controls[0]!.selector,
    }),
    /unavailable/u,
  );
  assert.equal(fixture.backend.actions.length, 0);
  await fixture.invoke("computer_press", undefined, {
    target,
    control: direct.controls[0]!.selector,
  });
  assert.equal(fixture.backend.actions.length, 1);
  await fixture.inspect(undefined);
  const newerDirect = await fixture.backend.inspect(target);
  await assert.rejects(
    fixture.invoke("computer_press", undefined, {
      target,
      control: newerDirect.controls[0]!.selector,
    }),
    /backend capture replaced/u,
  );
  assert.equal(fixture.backend.actions.length, 1);
});

function applyControlDiff(
  previous: Control[],
  delta: InspectionView,
): Control[] {
  assert.equal(delta.observation.format, "diff");
  const observationId = delta.observation.actionObservationId;
  assert.ok(observationId);
  const changes = delta.controlChanges!;
  const controls = new Map(
    previous.map((control) => [
      control.selector.targetId,
      {
        ...control,
        selector: { ...control.selector, observationId },
      },
    ]),
  );
  for (const id of changes.removedFromView) controls.delete(id);
  for (const control of [...changes.added, ...changes.updated])
    controls.set(control.selector.targetId, control);
  return changes.order === undefined
    ? [...controls.values()]
    : changes.order.map((id) => {
        const control = controls.get(id);
        assert.ok(control, `diff order references known control ${id}`);
        return control;
      });
}

function sceneControl(index: number): SceneControl {
  return {
    role: "AXTextField",
    title: `Control ${index}: ${"Exact native semantic label ".repeat(4)}`,
    enabled: true,
    actions: ["press", "set_value"],
  };
}

class FakeComputerBackend implements ZenXComputerBackend {
  scene: SceneControl[];
  inspections = 0;
  foregroundActions = 0;
  lastCapture: Control[] = [];
  readonly actions: Array<{
    action: string;
    control: ComputerControlSelector;
  }> = [];
  readonly latest = new Map<
    string,
    { observationId: string; controls: Control[] }
  >();

  constructor(
    count: number,
    readonly sourceComplete: boolean,
  ) {
    this.scene = Array.from({ length: count }, (_, index) =>
      sceneControl(index),
    );
  }

  async inspect(inspectedTarget: ComputerTarget): Promise<ComputerInspection> {
    const key = JSON.stringify(inspectedTarget);
    const observationId = `native-observation-${++this.inspections}`;
    const controls: Control[] = this.scene.map((control, index) => ({
      ...structuredClone(control),
      selector: { observationId, targetId: `raw-${this.inspections}-${index}` },
    }));
    this.lastCapture = controls;
    this.latest.set(key, { observationId, controls });
    return {
      platform: "darwin",
      observationId,
      target: this.summary(inspectedTarget),
      controls: controls.slice(0, 32),
      truncated: controls.length > 32 || !this.sourceComplete,
      [OBSERVATION_CAPTURE]: {
        scopeKey: `fixture-native-window:${key}`,
        entries: controls.map((value, index) => ({
          value,
          identity: JSON.stringify(this.scene[index]),
        })),
        coverage: {
          scope: "fixture-window-capture",
          sourceComplete: this.sourceComplete,
          reasons: this.sourceComplete ? [] : ["native_depth_limit"],
          itemTotal: controls.length,
        },
        assertCurrent: () => {
          if (this.latest.get(key)?.observationId !== observationId)
            throw new Error("backend capture replaced or consumed");
        },
      },
    };
  }

  async press(
    selectedTarget: ComputerTarget,
    control: ComputerControlSelector,
  ) {
    this.consume(selectedTarget, control, "press");
    return { target: this.summary(selectedTarget), control };
  }

  async setValue(
    selectedTarget: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
  ) {
    this.consume(selectedTarget, control, "set_value");
    return {
      target: this.summary(selectedTarget),
      control,
      characterCount: value.length,
    };
  }

  async screenshot(selectedTarget: ComputerTarget) {
    return {
      target: this.summary(selectedTarget),
      artifactPath: "/fixture/window.png",
      width: 800,
      height: 600,
      bytes: 100,
      expiresAt: new Date(0).toISOString(),
    };
  }

  async foregroundClick() {
    this.foregroundActions += 1;
  }
  async foregroundKeyPress() {
    this.foregroundActions += 1;
  }
  async foregroundScroll() {
    this.foregroundActions += 1;
  }
  close() {
    this.latest.clear();
  }

  private summary(
    selectedTarget: ComputerTarget,
  ): ComputerInspection["target"] {
    return {
      pid: selectedTarget.pid ?? 42,
      applicationName: "Fixture",
      windowTitle: selectedTarget.windowTitle,
    };
  }

  private consume(
    selectedTarget: ComputerTarget,
    control: ComputerControlSelector,
    action: string,
  ) {
    const key = JSON.stringify(selectedTarget);
    const current = this.latest.get(key);
    assert.equal(
      current?.observationId,
      control.observationId,
      "backend receives current observation ID",
    );
    assert.ok(
      current?.controls.some(
        (candidate) => candidate.selector.targetId === control.targetId,
      ),
      "backend receives its raw selector",
    );
    this.actions.push({ action, control: structuredClone(control) });
    this.latest.delete(key);
  }
}

function createFixture(count: number, sourceComplete = true) {
  const backend = new FakeComputerBackend(count, sourceComplete);
  const capability = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
  );
  let calls = 0;
  const invoke = async (
    name: string,
    threadId: string | undefined,
    arguments_: Record<string, unknown>,
  ) =>
    await capability.invoke(name, {
      callId: `call-${++calls}`,
      name,
      arguments: arguments_,
      cwd: "/fixture",
      signal: new AbortController().signal,
      ...(threadId === undefined ? {} : { threadId }),
    });
  const inspect = async (
    threadId: string | undefined,
    options: Record<string, unknown> = {},
  ): Promise<InspectionView> =>
    (await invoke("computer_inspect", threadId, {
      target,
      ...options,
    })) as InspectionView;
  return { backend, capability, invoke, inspect };
}

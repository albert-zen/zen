import assert from "node:assert/strict";
import test from "node:test";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import {
  computerModelDefinition,
  decodeComputerArguments,
  projectComputerResult,
} from "../src/main/capabilities/model-computer-facade.js";
import {
  ComputerZenXCapabilityPackage,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import type { ComputerEnvironmentPort } from "../src/main/automation-environment.js";

const epoch = "computer-v2";
const window = {
  pid: 431,
  windowTitle: "Messages",
  applicationId: "example.app",
};
const definition = (name: string, properties: Record<string, unknown>) =>
  computerModelDefinition({
    name,
    description: name,
    inputSchema: {
      type: "object",
      properties,
      required: ["target"],
      additionalProperties: false,
    },
  });

test("listed windows return exact owner-scoped refs usable by inspect, screenshot and select", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const listed = projectComputerResult(
    {
      windows: [{ target: window, applicationName: "Example" }],
      truncated: false,
    },
    {},
    refs,
    epoch,
  );
  const candidate = (listed.windows as Array<Record<string, unknown>>)[0]!;
  assert.match(candidate.ref as string, /^r[1-9]/);
  assert.equal(candidate.target, undefined);
  for (const name of [
    "computer_inspect",
    "computer_screenshot",
    "computer_select_target",
  ])
    assert.deepEqual(
      decodeComputerArguments(name, { target: candidate.ref }, refs, epoch),
      {
        target: window,
        ...(name === "computer_inspect" ? { full: true } : {}),
      },
    );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_inspect",
        { target: candidate.ref },
        new ModelReferenceRegistry().scope("other"),
        epoch,
      ),
    /reference|retired/i,
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_inspect",
        { target: candidate.ref },
        refs,
        "next-epoch",
      ),
    /reference|retired/i,
  );
  const schema = definition("computer_inspect", {
    target: { type: "object" },
    cursor: { type: "string" },
    baseObservationId: { type: "string" },
    full: { type: "boolean" },
  }).inputSchema;
  assert.equal(
    (schema.properties as Record<string, any>).target.anyOf[0].type,
    "string",
  );
});

test("since ref requests a native diff only for the same exact window and allows explicit full resync", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const first = projectComputerResult(
    { target: window, observationId: "obs-1", controls: [] },
    { target: window },
    refs,
    epoch,
  );
  const since = first.observation;
  assert.match(since as string, /^r[1-9]/);
  assert.deepEqual(
    decodeComputerArguments(
      "computer_inspect",
      { target: first.window, since },
      refs,
      epoch,
    ),
    { target: window, baseObservationId: "obs-1" },
  );
  assert.deepEqual(
    decodeComputerArguments(
      "computer_inspect",
      { target: first.window, full: true },
      refs,
      epoch,
    ),
    { target: window, full: true },
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_inspect",
        { target: first.window, since, full: true },
        refs,
        epoch,
      ),
    /since|full|baseline/i,
  );
  const other = { pid: 999, windowTitle: "Other" };
  const otherRef = projectComputerResult(
    { target: other, observationId: "obs-2", controls: [] },
    { target: other },
    refs,
    epoch,
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_inspect",
        { target: otherRef.window, since },
        refs,
        epoch,
      ),
    /window|target/i,
  );
});

test("retained control needs explicit current observation for action, preserving native pair", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const first = projectComputerResult(
    {
      target: window,
      observationId: "obs-1",
      controls: [
        {
          selector: { observationId: "obs-1", targetId: "node" },
          role: "button",
        },
      ],
    },
    { target: window },
    refs,
    epoch,
  );
  const second = projectComputerResult(
    { target: window, observationId: "obs-2", controls: [] },
    { target: window },
    refs,
    epoch,
  );
  assert.deepEqual(
    decodeComputerArguments(
      "computer_press",
      {
        control: (first.controls as any[])[0].ref,
        observation: second.observation,
      },
      refs,
      epoch,
    ),
    {
      target: window,
      control: { observationId: "obs-2", targetId: "node" },
      observe: true,
    },
  );
  const wrong = { pid: 333, windowTitle: "Wrong" };
  const unrelated = projectComputerResult(
    { target: wrong, observationId: "obs-wrong", controls: [] },
    { target: wrong },
    refs,
    epoch,
  );
  assert.throws(
    () =>
      decodeComputerArguments(
        "computer_press",
        {
          control: (first.controls as any[])[0].ref,
          observation: unrelated.observation,
        },
        refs,
        epoch,
      ),
    /window|target/i,
  );
});

test("focused Computer inspect reports the actual bounded captured scope", async () => {
  const target = { pid: 431, windowTitle: "Messages" };
  let observations = 0;
  const backend = {
    inspect: async () => ({
      platform: "win32",
      observationId: `obs-${++observations}`,
      target: { ...target, applicationName: "Example" },
      controls: ["Save", "Cancel", "Save as"].map((title, i) => ({
        selector: {
          observationId: `obs-${observations}`,
          targetId: `node-${i}`,
        },
        role: "button",
        title,
        enabled: true,
        actions: ["press"],
      })),
      truncated: false,
    }),
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(backend);
  const result = (await computer.invoke("computer_inspect", {
    name: "computer_inspect",
    callId: "call-1",
    threadId: "owner",
    cwd: ".",
    arguments: { target, query: "save", limit: 1 },
    signal: new AbortController().signal,
  } as any)) as Record<string, any>;
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].title, "Save");
  assert.deepEqual(result.focus, {
    query: "save",
    limit: 1,
    scanned: 3,
    matched: 2,
  });
  assert.match(result.coverage.scope, /focused projection/);
  assert.equal(result.coverage.sourceComplete, false);
  assert.ok(result.coverage.reasons.includes("focus_limit"));
  const changedScope = (await computer.invoke("computer_inspect", {
    name: "computer_inspect",
    callId: "call-2",
    threadId: "owner",
    cwd: ".",
    arguments: {
      target,
      query: "cancel",
      limit: 1,
      baseObservationId: result.observationId,
    },
    signal: new AbortController().signal,
  } as any)) as Record<string, any>;
  assert.equal(changedScope.observation.format, "full");
  assert.equal(changedScope.observation.resetReason, "scope-changed");
  await computer.close();
});

test("completed semantic action reports failed follow-up observation without replay", async () => {
  const target = { pid: 431, windowTitle: "Messages" };
  let inspections = 0,
    actions = 0;
  const backend = {
    inspect: async () => {
      inspections++;
      if (inspections === 2) throw new Error("AX timed out after dispatch");
      return {
        platform: "win32",
        observationId: "obs-1",
        target: { ...target, applicationName: "Example" },
        controls: [
          {
            selector: { observationId: "obs-1", targetId: "node-1" },
            role: "button",
            title: "Save",
            enabled: true,
            actions: ["press"],
          },
        ],
        truncated: false,
      };
    },
    press: async () => {
      actions++;
      return { target: { ...target, applicationName: "Example" } };
    },
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(backend);
  const signal = new AbortController().signal;
  const inspection = (await computer.invoke("computer_inspect", {
    name: "computer_inspect",
    callId: "inspect",
    threadId: "owner",
    cwd: ".",
    arguments: { target },
    signal,
  } as any)) as Record<string, any>;
  const action = (await computer.invoke("computer_press", {
    name: "computer_press",
    callId: "press",
    threadId: "owner",
    cwd: ".",
    arguments: {
      target,
      control: inspection.controls[0].selector,
      observe: true,
    },
    signal,
  } as any)) as Record<string, any>;
  assert.equal(actions, 1);
  assert.equal(action.actionCompleted, true);
  assert.match(action.observationError, /AX timed out/);
  assert.equal(action.after, undefined);
  await computer.close();
});

test("default action observation is a small honest subset; full explicitly reopens the captured first page", async () => {
  const target = { pid: 431, windowTitle: "Messages" };
  let observations = 0,
    actions = 0;
  const backend = {
    inspect: async () => {
      const observationId = `obs-${++observations}`;
      return {
        platform: "win32",
        observationId,
        target: { ...target, applicationName: "Example" },
        controls: Array.from({ length: 12 }, (_, i) => ({
          selector: { observationId, targetId: `node-${i}` },
          role: "button",
          title: `Button ${i}`,
          enabled: true,
          actions: ["press"],
        })),
        truncated: false,
      };
    },
    press: async () => {
      actions++;
      return { target };
    },
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(backend);
  const signal = new AbortController().signal;
  const call = (name: string, arguments_: Record<string, unknown>) =>
    computer.invoke(name, {
      name,
      callId: `${name}-${observations}-${actions}`,
      threadId: "owner",
      cwd: ".",
      arguments: arguments_,
      signal,
    } as any) as Promise<Record<string, any>>;
  const first = await call("computer_inspect", { target });
  const focused = await call("computer_press", {
    target,
    control: first.controls[7].selector,
    observe: true,
  });
  assert.equal(actions, 1);
  assert.equal(focused.actionCompleted, true);
  assert.equal(focused.after.controls.length, 5);
  assert.equal(focused.after.focus.kind, "action-followup");
  assert.equal(focused.after.focus.match, "same-presented-control");
  assert.equal(focused.after.focus.inspectToExpand, true);
  assert.equal(focused.after.coverage.sourceComplete, false);
  assert.ok(focused.after.coverage.reasons.includes("action_followup_subset"));
  assert.equal(
    focused.after.controls.some((c: any) => c.title === "Button 7"),
    true,
  );
  const complete = await call("computer_inspect", { target, full: true });
  assert.equal(complete.controls.length, 12);
  await computer.close();
});

test("two model-facing diffs replace every retained ref and permit an exact native action", async () => {
  const target = { pid: 431, windowTitle: "Messages" };
  let observations = 0,
    pressed = "";
  const backend = {
    inspect: async () => {
      const observationId = `obs-${++observations}`;
      return {
        platform: "win32",
        observationId,
        target: { ...target, applicationName: "Example" },
        controls: Array.from({ length: 16 }, (_, i) => ({
          selector: { observationId, targetId: `node-${i}` },
          role: "button",
          title:
            i === 0 && observations >= 3
              ? "Changed button"
              : `Button ${i} with enough text for a useful native diff`,
          enabled: true,
          actions: ["press"],
        })),
        truncated: false,
      };
    },
    press: async (
      _target: unknown,
      selector: { observationId: string; targetId: string },
    ) => {
      pressed = `${selector.observationId}/${selector.targetId}`;
      return { target };
    },
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(backend);
  const refs = new ModelReferenceRegistry().scope("owner");
  const signal = new AbortController().signal;
  const call = async (name: string, modelArgs: Record<string, unknown>) => {
    const native = decodeComputerArguments(name, modelArgs, refs, epoch);
    const raw = (await computer.invoke(name, {
      name,
      callId: `${name}-${observations}`,
      threadId: "owner",
      cwd: ".",
      arguments: native,
      signal,
    } as any)) as Record<string, unknown>;
    return projectComputerResult(raw, native, refs, epoch);
  };
  const first = await call("computer_inspect", { target });
  let state = new Map(
    (first.controls as Array<Record<string, unknown>>).map((c) => [
      c.ref as string,
      c,
    ]),
  );
  let previous = first;
  for (let step = 0; step < 2; step++) {
    const next = await call("computer_inspect", {
      target: first.window,
      since: previous.observation,
    });
    assert.equal((next.page as Record<string, unknown>).format, "diff");
    const changes = next.controlChanges as Record<string, any>;
    assert.equal(changes.replacements.length, 16);
    for (const replacement of changes.replacements as Array<{
      beforeRef: string;
      ref: string;
    }>) {
      const old = state.get(replacement.beforeRef);
      assert.ok(old, "each previous ref has an explicit fresh successor");
      state.delete(replacement.beforeRef);
      state.set(replacement.ref, { ...old, ref: replacement.ref });
    }
    for (const updated of changes.updated as Array<Record<string, unknown>>)
      state.set(updated.ref as string, updated);
    assert.deepEqual(changes.order, [...state.keys()]);
    previous = next;
  }
  const retained = [...state.values()].find(
    (c) => c.title === "Button 1 with enough text for a useful native diff",
  )!;
  await call("computer_press", {
    control: retained.ref,
    observation: previous.observation,
    observe: false,
  });
  assert.equal(pressed, "obs-3/node-1");
  await computer.close();
});

test("desktop invalidation retires model capture and native selector before next action", async () => {
  const target = { pid: 431, windowTitle: "Messages" };
  let invalidations = 0,
    actions = 0,
    revision = 1;
  let notify: (() => void) | undefined;
  const environment: ComputerEnvironmentPort = {
    snapshot: () => ({
      platform: "win32",
      sessionState: revision === 1 ? "active" : "locked",
      revision,
      displayState: "unknown",
      lockedUse: "unsupported",
      keepAwake: "unavailable",
    }),
    acquire: (signal) => {
      if (revision !== 1)
        throw new Error("Computer session is locked; no input dispatched");
      return { signal, revision, release() {} };
    },
    onInvalidated: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  };
  const backend = {
    inspect: async () => ({
      platform: "win32",
      observationId: "obs-1",
      target: { ...target, applicationName: "Example" },
      controls: [
        {
          selector: { observationId: "obs-1", targetId: "node-1" },
          role: "button",
          title: "Save",
          enabled: true,
          actions: ["press"],
        },
      ],
      truncated: false,
    }),
    press: async () => {
      actions++;
      return { target };
    },
    invalidateObservations: () => {
      invalidations++;
    },
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    false,
    undefined,
    environment,
  );
  const signal = new AbortController().signal;
  const inspection = (await computer.invoke("computer_inspect", {
    name: "computer_inspect",
    callId: "inspect",
    threadId: "owner",
    cwd: ".",
    arguments: { target },
    signal,
  } as any)) as Record<string, any>;
  const available = (await computer.invoke("computer_environment", {
    name: "computer_environment",
    callId: "env",
    threadId: "owner",
    cwd: ".",
    arguments: {},
    signal,
  } as any)) as Record<string, any>;
  assert.equal(available.sessionState, "active");
  revision++;
  notify?.();
  assert.equal(invalidations, 1);
  await assert.rejects(
    computer.invoke("computer_press", {
      name: "computer_press",
      callId: "press",
      threadId: "owner",
      cwd: ".",
      arguments: {
        target,
        control: inspection.controls[0].selector,
        observe: true,
      },
      signal,
    } as any),
    /locked|expired|stale/i,
  );
  assert.equal(actions, 0);
  await computer.close();
  assert.equal(notify, undefined);
});

test("stale foreground binding never labels another selected window busy", async () => {
  const selected = { pid: 432, windowTitle: "Selected" };
  const events: Array<Record<string, any>> = [];
  const backend = {
    targetSession: {
      selectedTarget: (_owner: string, expectedBindingId?: string) =>
        expectedBindingId === "current" ? selected : undefined,
      selectedBindingId: () => "current",
    },
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(backend, undefined, true);
  const stop = computer.observeThread(
    { threadId: "owner", frames: false },
    (event) => events.push(event as Record<string, any>),
  );
  await assert.rejects(
    computer.invoke("computer_foreground_key_press", {
      name: "computer_foreground_key_press",
      callId: "stale",
      threadId: "owner",
      cwd: ".",
      arguments: { key: "enter", bindingId: "prior" },
      signal: new AbortController().signal,
    } as any),
    /bindingId no longer matches/i,
  );
  assert.ok(
    events.every(
      (event) =>
        event.type !== "targets" ||
        event.targets.every((target: Record<string, any>) => !target.activity),
    ),
  );
  stop();
  await computer.close();
});

test("locked native AX uses fresh scoped observations while capture and foreground stay blocked", async () => {
  const { EventEmitter } = await import("node:events");
  const { AutomationEnvironment } =
    await import("../src/main/automation-environment.js");
  const monitor = Object.assign(new EventEmitter(), {
    idle: "active",
    getSystemIdleState() {
      return this.idle;
    },
  });
  const environment = new AutomationEnvironment({
    platform: "darwin",
    monitor,
    nativeSessionProbe: async () =>
      monitor.getSystemIdleState() as "active" | "locked",
  });
  let dispatched = 0;
  const target = { pid: 431, windowTitle: "Fixture" };
  const backend = {
    nativeTargetedAccessibility: true,
    inspect: async () => ({
      platform: "darwin",
      observationId: "fresh",
      target: { ...target, applicationName: "Fixture" },
      controls: [
        {
          selector: { observationId: "fresh", targetId: "button" },
          role: "button",
          title: "Save",
          enabled: true,
          actions: ["press"],
        },
      ],
      truncated: false,
    }),
    press: async () => {
      dispatched++;
      return { target };
    },
    invalidateObservations() {},
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    false,
    undefined,
    environment,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    computer.invoke(name, {
      name,
      callId: name,
      threadId: "owner",
      cwd: ".",
      arguments: args,
      signal: new AbortController().signal,
    } as any);
  const capability = (await call("computer_environment", {})) as any;
  assert.equal(capability.lockedUse, "native-targeted-accessibility");
  assert.deepEqual(capability.lockedTools, [
    "computer_list_windows",
    "computer_inspect",
    "computer_press",
    "computer_set_value",
  ]);
  const old = (await call("computer_inspect", { target })) as any;
  monitor.idle = "locked";
  monitor.emit("lock-screen");
  await assert.rejects(
    call("computer_press", {
      target,
      control: old.controls[0].selector,
      observe: false,
    }),
    /expired|stale|inspect/i,
  );
  assert.equal(dispatched, 0);
  const fresh = (await call("computer_inspect", { target })) as any;
  const acted = (await call("computer_press", {
    target,
    control: fresh.controls[0].selector,
    observe: false,
  })) as any;
  assert.ok(
    acted.after,
    "locked actions always return a fresh native readback even when observation was omitted",
  );
  assert.equal(acted.applicationEffect, "unverified");
  assert.equal(dispatched, 1);
  assert.equal(environment.snapshot().sessionState, "locked");
  await assert.rejects(call("computer_screenshot", { target }), /locked/);
  computer.setForegroundControlAllowed(true);
  await assert.rejects(
    call("computer_foreground_key_press", { key: "enter" }),
    /locked/,
  );
  await computer.close();
  environment.close();
});

test("generic provider metadata cannot grant locked native AX admission", async () => {
  const { EventEmitter } = await import("node:events");
  const { AutomationEnvironment } =
    await import("../src/main/automation-environment.js");
  const monitor = Object.assign(new EventEmitter(), {
    getSystemIdleState: () => "locked",
  });
  const environment = new AutomationEnvironment({
    platform: "darwin",
    monitor,
    nativeSessionProbe: async () =>
      monitor.getSystemIdleState() as "active" | "locked",
  });
  let dispatched = false;
  const backend = {
    inspect: async () => {
      dispatched = true;
    },
    close: async () => {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
    undefined,
    environment,
  );
  await assert.rejects(
    computer.invoke("computer_inspect", {
      arguments: { target: { pid: 431, windowTitle: "Fixture" } },
      signal: new AbortController().signal,
    } as any),
    /locked/,
  );
  assert.equal(dispatched, false);
  await computer.close();
  environment.close();
});

test("foreground consent revoked during native session refresh cannot be revived by regrant", async () => {
  let done!: () => void;
  const waiting = new Promise<void>((resolve) => {
    done = resolve;
  });
  const environment = {
    refresh: () => waiting,
    snapshot: () => ({
      platform: "darwin",
      sessionState: "active",
      revision: 1,
      displayState: "unknown",
      lockedUse: "provider-dependent",
      keepAwake: "inactive",
    }),
    onInvalidated: () => () => {},
    acquire: (signal: AbortSignal) => ({ signal, revision: 1, release() {} }),
  } as ComputerEnvironmentPort;
  const backend = { close() {} } as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
    undefined,
    environment,
  );
  const pending = computer.invoke("computer_foreground_key_press", {
    arguments: { key: "enter" },
    signal: new AbortController().signal,
  } as any);
  computer.setForegroundControlAllowed(false);
  computer.setForegroundControlAllowed(true);
  done();
  await assert.rejects(pending, /foreground_required/);
  await computer.close();
});

test("late native ACK after lock and unlock cannot revive an old preview", async () => {
  let revision = 1;
  let state: "active" | "locked" = "active";
  let notify!: () => void;
  const generation = new AbortController();
  const environment = {
    snapshot: () => ({
      platform: "darwin",
      sessionState: state,
      revision,
      displayState: "unknown",
      lockedUse: "provider-dependent",
      keepAwake: "inactive",
    }),
    acquire: (signal: AbortSignal) => ({
      signal: AbortSignal.any([signal, generation.signal]),
      revision,
      release() {},
    }),
    onInvalidated: (listener: () => void) => {
      notify = listener;
      return () => {};
    },
  } as ComputerEnvironmentPort;
  let finish!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let captures = 0;
  const target = { pid: 431, windowTitle: "Fixture" };
  const backend = {
    inspect: async () => ({
      platform: "darwin",
      observationId: "old",
      target: { ...target, applicationName: "Fixture" },
      controls: [
        {
          selector: { observationId: "old", targetId: "button" },
          role: "button",
          title: "Save",
          enabled: true,
          actions: ["press"],
        },
      ],
      truncated: false,
    }),
    press: async () => {
      started();
      await pending;
      return { target };
    },
    observeWindow: () => {
      captures++;
      return () => {};
    },
    close() {},
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
    undefined,
    environment,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    computer.invoke(name, {
      name,
      callId: name,
      threadId: "owner",
      arguments: args,
      signal: new AbortController().signal,
    } as any);
  const inspected = (await call("computer_inspect", { target })) as any;
  computer.observeThread({ threadId: "owner", frames: true }, () => {});
  assert.equal(captures, 1);
  const action = call("computer_press", {
    target,
    control: inspected.controls[0].selector,
    observe: true,
  });
  await dispatched;
  state = "locked";
  revision++;
  generation.abort();
  notify();
  state = "active";
  revision++;
  notify();
  finish();
  const result = (await action) as any;
  assert.ok(result.observationError);
  assert.equal(
    captures,
    1,
    "old native completion never certifies current pixels",
  );
  await computer.close();
});

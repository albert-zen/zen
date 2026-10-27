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

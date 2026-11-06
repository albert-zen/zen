import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createAppShotService,
  type AppShotDependencies,
  type AppShotCaptureOptions,
} from "../src/main/app-shot.js";

const identity = {
  windowId: 42,
  pid: 777,
  windowTitle: "Chosen window",
  applicationName: "Synthetic editor",
  bounds: { x: 20, y: 30, width: 800, height: 600 },
};
function harness(overrides: Partial<AppShotDependencies> = {}) {
  let captures = 0,
    enumerations = 0;
  const service = createAppShotService({
    getWindowSources: async (size) => {
      enumerations++;
      assert.deepEqual(size, { width: 0, height: 0 });
      return [
        {
          id: "window:42:0",
          title: "Chosen window",
          get image(): never {
            throw new Error("must not inspect thumbnails");
          },
        },
        {
          id: "window:43:0",
          title: "Other window",
          get image(): never {
            throw new Error("must not inspect other pixels");
          },
        },
      ];
    },
    getWindowMetadata: async () => identity,
    getActiveWindow: async () => identity,
    captureWindowSurface: async (target) => {
      assert.deepEqual(target, identity);
      captures++;
      return Buffer.from([1, 2]);
    },
    ...overrides,
  });
  return {
    service,
    get captures() {
      return captures;
    },
    get enumerations() {
      return enumerations;
    },
  };
}

it("selected and foreground macOS captures enumerate zero thumbnails and collect one surface", async () => {
  const h = harness();
  assert.equal(h.service.hasExactWindowSurfaceCapture, true);
  const [selected] = await h.service.listSources();
  assert.match(
    (await h.service.capture(selected!.id)).context,
    /exact macOS window surface/,
  );
  assert.match((await h.service.captureActive())!.context, /Synthetic editor/);
  assert.equal(h.captures, 2);
  assert.equal(h.enumerations, 4);
});

it("mandatory selected PID/title/bounds failures never reach surface collection", async () => {
  for (const metadata of [
    undefined,
    { ...identity, pid: process.pid },
    { ...identity, pid: 0 },
    { ...identity, bounds: undefined },
    { ...identity, windowTitle: "Different" },
    { ...identity, windowId: 43 },
  ]) {
    const h = harness({
      getWindowMetadata: async () => {
        if (!metadata) throw new Error("unavailable");
        return metadata;
      },
    });
    const [selected] = await h.service.listSources();
    await assert.rejects(h.service.capture(selected!.id), /exact external/);
    assert.equal(h.captures, 0);
  }
  const missing = harness({ getWindowMetadata: undefined });
  const [selected] = await missing.service.listSources();
  await assert.rejects(missing.service.capture(selected!.id), /exact external/);
  assert.equal(missing.captures, 0);
});

it("foreground PID or bounds replacement cannot rebind its initial same-ID/title observation", async () => {
  for (const next of [
    { ...identity, pid: 778 },
    { ...identity, bounds: { ...identity.bounds, x: 21 } },
  ]) {
    const h = harness({ getWindowMetadata: async () => next });
    await assert.rejects(h.service.captureActive(), /exact external/);
    assert.equal(h.captures, 0);
  }
});

it("host expected identities narrow both paths before pixels and never authorize a fallback", async () => {
  for (const expectedIdentity of [
    { ...identity, pid: 778 },
    { ...identity, windowId: 43 },
    { ...identity, bounds: undefined },
    null,
    "window:42:0",
  ]) {
    const h = harness();
    const [selected] = await h.service.listSources();
    const options = { expectedIdentity } as AppShotCaptureOptions;
    await assert.rejects(
      h.service.capture(selected!.id, options),
      /identity|exact external/i,
    );
    await assert.rejects(
      h.service.captureActive(options),
      /identity|exact external/i,
    );
    assert.equal(h.captures, 0);
  }
  const h = harness();
  const [selected] = await h.service.listSources();
  await h.service.capture(selected!.id, { expectedIdentity: identity });
  await h.service.captureActive({ expectedIdentity: identity });
  assert.equal(h.captures, 2);
  let native = 0;
  const unsupported = harness({
    captureWindowSurface: undefined,
    captureActiveNative: async () => {
      native++;
      return undefined;
    },
  });
  await assert.rejects(
    unsupported.service.captureActive({ expectedIdentity: identity }),
    /unsupported/,
  );
  const [other] = await unsupported.service.listSources();
  await assert.rejects(
    unsupported.service.capture(other!.id, { expectedIdentity: identity }),
    /unsupported/,
  );
  assert.equal(native, 0);
});

it("capture denial has no thumbnail or alternate-window retry", async () => {
  let attempts = 0;
  const h = harness({
    captureWindowSurface: async () => {
      attempts++;
      throw new Error("synthetic permission denial");
    },
  });
  await assert.rejects(h.service.captureActive(), /permission denial/);
  assert.equal(attempts, 1);
  assert.equal(h.enumerations, 2);
});

it("post-capture and post-AX identity/exclusion drift discard the whole review", async () => {
  for (const phase of ["capture", "text", "exclusion"] as const) {
    let changed = false;
    const h = harness({
      getWindowMetadata: async () =>
        changed && phase !== "exclusion" ? { ...identity, pid: 778 } : identity,
      captureWindowSurface: async () => {
        if (phase === "capture") changed = true;
        return Buffer.from([1]);
      },
      readAccessibility: async () => {
        changed = true;
        return { ...identity, text: "Synthetic text" };
      },
      excludedSourceIds: () =>
        phase === "exclusion" && changed ? ["window:42:0"] : [],
    });
    const [selected] = await h.service.listSources();
    await assert.rejects(
      h.service.capture(selected!.id, { includeAccessibility: true }),
      /changed during/,
    );
  }
});

it("cancellation and token refresh during metadata enumeration prevent surface collection", async () => {
  const controller = new AbortController();
  const h = harness({
    getWindowMetadata: async () => {
      controller.abort();
      return identity;
    },
  });
  const [selected] = await h.service.listSources();
  await assert.rejects(
    h.service.capture(selected!.id, { signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(h.captures, 0);
  let refresh = false;
  const stale = harness({
    getWindowMetadata: async () => {
      if (!refresh) {
        refresh = true;
        await stale.service.listSources();
      }
      return identity;
    },
  });
  const [old] = await stale.service.listSources();
  await assert.rejects(stale.service.capture(old!.id), /stale/);
  assert.equal(stale.captures, 0);
});

it("a host expected identity cannot be ignored by an independent native active callback", async () => {
  let native = 0;
  // A surface callback covers selected windows, not a separately installed foreground backend.
  const h = harness({
    captureActiveNative: async () => {
      native++;
      return undefined;
    },
  });
  await assert.rejects(
    h.service.captureActive({ expectedIdentity: identity }),
    /unsupported/,
  );
  assert.equal(native, 0);
  assert.equal(h.captures, 0);
  assert.equal(h.enumerations, 0);
});

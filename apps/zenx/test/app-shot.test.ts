import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAppShotService,
  fitAppShotDimensions,
  sameObservedWindow,
  windowsAppShotDraft,
  niriAppShotDraft,
  type AppShotNativeSource,
} from "../src/main/app-shot.js";

function source(
  id: string,
  title: string,
  bytes = new Uint8Array([1, 2, 3]),
): AppShotNativeSource {
  return {
    id,
    title,
    image: { isEmpty: () => bytes.length === 0, toPNG: () => bytes },
  };
}

function harness(initial: AppShotNativeSource[]) {
  let sources = initial;
  const calls: Array<{ width: number; height: number }> = [];
  const service = createAppShotService({
    getWindowSources: async (size) => {
      calls.push(size);
      return sources;
    },
    excludedSourceIds: () => ["window:99:0"],
  });
  return {
    service,
    calls,
    setSources: (next: AppShotNativeSource[]) => {
      sources = next;
    },
  };
}

describe("App Shot capture", () => {
  it("lists only external windows without collecting preview images", async () => {
    const h = harness([
      source("window:1:0", "Report"),
      source("screen:2:0", "Display"),
      source("window:99:0", "ZenX"),
    ]);
    const listed = await h.service.listSources();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.title, "Report");
    assert.notEqual(listed[0]?.id, "window:1:0");
    assert.deepEqual(h.calls, [{ width: 0, height: 0 }]);
  });

  it("captures only the exact selected source and labels screenshot-only context", async () => {
    const h = harness([source("window:1:0", "Report")]);
    const [selection] = await h.service.listSources();
    assert.ok(selection);
    const shot = await h.service.capture(selection.id);
    assert.deepEqual(shot.bytes, new Uint8Array([1, 2, 3]));
    assert.equal(shot.mediaType, "image/png");
    assert.match(shot.context, /Report/);
    assert.match(shot.context, /screenshot only/i);
    assert.deepEqual(h.calls, [
      { width: 0, height: 0 },
      { width: 1600, height: 1000 },
    ]);
  });

  it("rejects unlisted, stale, closed, renamed, ambiguous and empty windows", async () => {
    const h = harness([source("window:1:0", "Report")]);
    const [selection] = await h.service.listSources();
    assert.ok(selection);
    await assert.rejects(h.service.capture("window:1:0"), /selection/i);
    h.setSources([]);
    await assert.rejects(
      h.service.capture(selection.id),
      /no longer available/i,
    );
    h.setSources([source("window:1:0", "Changed")]);
    await assert.rejects(h.service.capture(selection.id), /changed/i);
    h.setSources([
      source("window:1:0", "Report"),
      source("window:1:0", "Report"),
    ]);
    await assert.rejects(h.service.capture(selection.id), /ambiguous/i);
    h.setSources([source("window:1:0", "Report", new Uint8Array())]);
    await assert.rejects(h.service.capture(selection.id), /empty/i);
    await h.service.listSources();
    await assert.rejects(h.service.capture(selection.id), /selection/i);
  });

  it("does not attach accessibility text unless matching the exact window ID and title; bounds it", async () => {
    const match = createAppShotService({
      getWindowSources: async () => [source("window:123:0", "Notes")],
      readAccessibility: async () => ({
        windowId: 123,
        windowTitle: "Notes",
        pid: 456,
        applicationName: "Editor",
        text: "x".repeat(40_000),
      }),
    });
    const [selected] = await match.listSources();
    assert.ok(selected);
    const shot = await match.capture(selected.id, {
      includeAccessibility: true,
    });
    assert.match(shot.context, /Editor/);
    assert.ok(shot.context.length < 34_000);
    const mismatch = createAppShotService({
      getWindowSources: async () => [source("window:123:0", "Notes")],
      readAccessibility: async () => ({
        windowId: 124,
        windowTitle: "Notes",
        pid: 456,
        text: "SECRET_OTHER_WINDOW",
      }),
    });
    const [other] = await mismatch.listSources();
    assert.ok(other);
    const otherShot = await mismatch.capture(other.id, {
      includeAccessibility: true,
    });
    assert.doesNotMatch(otherShot.context, /SECRET_OTHER_WINDOW/);
    assert.match(otherShot.context, /screenshot only/i);
  });
  it("captures only a uniquely identified active window and rejects a changed target", async () => {
    let active = 8;
    const service = createAppShotService({
      getWindowSources: async () => [
        source("window:8:0", "Chosen"),
        source("window:9:0", "Other"),
      ],
      getActiveWindow: async () => ({
        windowId: active,
        windowTitle: "Chosen",
        pid: 22,
        applicationName: "Editor",
      }),
    });
    const activeShot = await service.captureActive();
    assert.ok(activeShot);
    assert.equal(activeShot.name, "Chosen.png");
    assert.match(activeShot.context, /Application: Editor/);
    active = 7;
    await assert.rejects(service.captureActive(), /unavailable or ambiguous/i);
    const changed = createAppShotService({
      getWindowSources: async () => [source("window:8:0", "Chosen")],
      getActiveWindow: async () => ({
        windowId: active++ === 7 ? 8 : 9,
        windowTitle: "Chosen",
        pid: 22,
      }),
    });
    await assert.rejects(changed.captureActive(), /changed during/i);
    await assert.rejects(
      harness([]).service.captureActive(),
      /unavailable on this platform/i,
    );
  });
  it("includes selected app metadata only when CG ID and title match", async () => {
    const matching = createAppShotService({
      getWindowSources: async () => [source("window:22:0", "Report")],
      getWindowMetadata: async () => ({
        windowId: 22,
        windowTitle: "Report",
        pid: 555,
        applicationName: "Writer",
      }),
    });
    const [chosen] = await matching.listSources();
    assert.ok(chosen);
    assert.match((await matching.capture(chosen.id)).context, /in Writer/);
    const mismatched = createAppShotService({
      getWindowSources: async () => [source("window:22:0", "Report")],
      getWindowMetadata: async () => ({
        windowId: 23,
        windowTitle: "Report",
        pid: 555,
        applicationName: "SECRET_WRONG_APP",
      }),
    });
    const [other] = await mismatched.listSources();
    assert.ok(other);
    assert.doesNotMatch(
      (await mismatched.capture(other.id)).context,
      /SECRET_WRONG_APP/,
    );
  });
});

describe("T3 native integration boundary", () => {
  it("uses the native active-window backend without enumeration or fallback", async () => {
    let calls = 0;
    const service = createAppShotService({
      getWindowSources: async () => {
        throw new Error("must not enumerate");
      },
      captureActiveNative: async (options) => {
        calls++;
        assert.equal(options?.includeAccessibility, true);
        throw new Error("permission denied");
      },
    });
    await assert.rejects(
      service.captureActive({ includeAccessibility: true }),
      /permission denied/,
    );
    assert.equal(calls, 1);
  });

  it("rejects a reused window identity or changed bounds", async () => {
    const a = {
      windowId: 1,
      windowTitle: "Editor",
      pid: 2,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    assert.equal(sameObservedWindow(a, { ...a }), true);
    assert.equal(sameObservedWindow(a, { ...a, pid: 3 }), false);
    assert.equal(
      sameObservedWindow(a, { ...a, bounds: { ...a.bounds, x: 1 } }),
      false,
    );
    let reads = 0;
    const service = createAppShotService({
      getWindowSources: async () => [source("window:1:0", "Editor")],
      getWindowMetadata: async () => ({ ...a, pid: reads++ === 0 ? 2 : 3 }),
    });
    const [selected] = await service.listSources();
    await assert.rejects(service.capture(selected!.id), /changed during/);
  });

  it("labels Windows occlusion and keeps optional text as draft data", () => {
    const shot = windowsAppShotDraft(
      {
        identity: {
          platform: "win32",
          windowId: 1,
          pid: 2,
          windowTitle: "Editor",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
        captureKind: "screen-region",
        region: { x: 0, y: 0, width: 800, height: 600 },
        png: Buffer.from([1, 2]),
        width: 800,
        height: 600,
        accessibility: { text: "User-visible window text", truncated: false },
      },
      true,
    );
    assert.match(shot.context, /Overlapping windows may appear/);
    assert.match(shot.context, /User-visible window text/);
    assert.match(shot.context, /not permission to control/);
    assert.equal(shot.mediaType, "image/png");
  });
});

it("fits native App Shot dimensions without upscaling or changing aspect ratio", () => {
  assert.deepEqual(fitAppShotDimensions({ width: 5120, height: 2880 }), {
    width: 2560,
    height: 1440,
  });
  assert.deepEqual(fitAppShotDimensions({ width: 1920, height: 3840 }), {
    width: 800,
    height: 1600,
  });
  assert.deepEqual(fitAppShotDimensions({ width: 800, height: 600 }), {
    width: 800,
    height: 600,
  });
  assert.throws(() => fitAppShotDimensions({ width: 0, height: 1 }), /invalid/);
});

it("Niri image-only identity drift never invents metadata or claims text availability", () => {
  const draft = niriAppShotDraft(
    { png: Buffer.from([1]), width: 1, height: 1 },
    true,
  );
  assert.match(draft.context, /metadata is omitted/);
  assert.match(draft.context, /accessibility text is not implemented/);
  assert.match(draft.context, /not permission to control/);
});

it("generic portal draft preserves pixels without inventing a window or AX identity", async () => {
  const { portalAppShotDraft } = await import("../src/main/app-shot.js");
  const bytes = new Uint8Array([1]);
  const result = portalAppShotDraft({ png: bytes, width: 1, height: 1 }, true);
  assert.equal(result.bytes, bytes);
  assert.match(result.context, /no verified application or window identity/);
  assert.match(result.context, /cannot be matched/);
});

it("Wayland detection follows explicit variables or confirms a live runtime socket", async () => {
  const { isWaylandAppShotSession } = await import("../src/main/app-shot.js");
  const probe = {
    entries: () => ["wayland-1", "wayland-2.lock"],
    socket: () => true,
    unixSockets: () => "a b c /run/user/1/wayland-1\n",
  };
  assert.equal(
    isWaylandAppShotSession(
      { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" },
      probe,
    ),
    true,
  );
  assert.equal(
    isWaylandAppShotSession(
      { XDG_SESSION_TYPE: "x11", XDG_RUNTIME_DIR: "/run/user/1" },
      probe,
    ),
    false,
  );
  assert.equal(
    isWaylandAppShotSession({ XDG_RUNTIME_DIR: "/run/user/1" }, probe),
    true,
  );
  assert.equal(
    isWaylandAppShotSession(
      { XDG_RUNTIME_DIR: "/run/user/1" },
      { ...probe, socket: () => false },
    ),
    false,
  );
  assert.equal(
    isWaylandAppShotSession(
      { XDG_RUNTIME_DIR: "/run/user/1" },
      { ...probe, unixSockets: () => "" },
    ),
    false,
  );
  assert.equal(isWaylandAppShotSession({}, probe), false);
});

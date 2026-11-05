import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAppShotService,
  fitAppShotDimensions,
  sameObservedWindow,
  windowsAppShotDraft,
  niriAppShotDraft,
  captureWaylandAppShot,
  gnomeAppShotDraft,
  gnomeAppShotIdentity,
  niriAppShotIdentity,
  nativeWaylandAppShotIdentity,
  nativeWaylandAppShotDraft,
  type AppShotNativeSource,
} from "../src/main/app-shot.js";

const nativeWaylandFixture = {
  png: Buffer.from([1]),
  width: 100,
  height: 100,
  window: {
    id: "{kde-private-window-id}",
    title: "Notes",
    appName: "Editor",
    appIdentifier: "test.editor",
    processId: 10,
    bounds: { x: 400, y: 100, width: 900, height: 600 },
    clientBounds: { x: 405, y: 130, width: 890, height: 565 },
  },
};

for (const backend of ["KDE", "Hyprland"] as const) {
  it(`${backend} prefers ready native pixels, gates AX by trusted identity and never falls back after failure`, async () => {
    let textReads = 0,
      portalCalls = 0;
    const dependencies = {
      ...(backend === "KDE"
        ? {
            kdeSupport: async () => ({
              status: "ready" as const,
              available: true,
              message: "",
              protocolVersion: 1 as const,
              feedbackAvailable: false as const,
            }),
            captureKde: async () => nativeWaylandFixture,
          }
        : {
            hyprlandSupport: async () => ({
              status: "ready" as const,
              message: "",
              feedbackAvailable: false as const,
            }),
            captureHyprland: async () => nativeWaylandFixture,
          }),
      captureGnome: async () => {
        throw new Error("unexpected GNOME");
      },
      capturePortal: async () => {
        portalCalls++;
        return undefined;
      },
      readNativeAccessibility: async () => {
        textReads++;
        return { text: "Unique text", truncated: true };
      },
    };
    assert.match(
      (await captureWaylandAppShot(false, dependencies))!.context,
      new RegExp(backend + " window"),
    );
    assert.equal(textReads, 0);
    assert.match(
      (await captureWaylandAppShot(true, dependencies))!.context,
      /read-only, truncated.*Unique text/,
    );
    assert.equal(textReads, 1);
    const captureKey = backend === "KDE" ? "captureKde" : "captureHyprland";
    const pixels = { png: Buffer.from([1]), width: 100, height: 100 };
    const screenshotOnly = await captureWaylandAppShot(true, {
      ...dependencies,
      [captureKey]: async () => pixels,
    });
    assert.match(screenshotOnly!.context, /metadata is omitted/);
    assert.doesNotMatch(screenshotOnly!.context, /Unique text/);
    assert.equal(textReads, 1);
    await assert.rejects(
      captureWaylandAppShot(false, {
        ...dependencies,
        [captureKey]: async () => {
          throw new Error("denied or cancelled");
        },
      }),
      /denied or cancelled/,
    );
    assert.equal(portalCalls, 0);
  });
}

it("native Wayland readiness distinguishes absent setup from denial and unusable installed helpers", async () => {
  let portalCalls = 0;
  const dependencies = {
    captureGnome: async () => {
      throw new Error("unexpected GNOME");
    },
    capturePortal: async () => {
      portalCalls++;
      return undefined;
    },
  };
  for (const status of ["manual-setup-required", "unavailable"] as const) {
    await captureWaylandAppShot(false, {
      ...dependencies,
      kdeSupport: async () => ({
        status,
        available: false,
        message: "missing",
        protocolVersion: 1,
        feedbackAvailable: false,
      }),
    });
  }
  for (const status of ["not-installed", "unsupported-session"] as const) {
    await captureWaylandAppShot(false, {
      ...dependencies,
      hyprlandSupport: async () => ({
        status,
        message: "missing",
        feedbackAvailable: false,
      }),
    });
  }
  assert.equal(portalCalls, 4);
  await assert.rejects(
    captureWaylandAppShot(false, {
      ...dependencies,
      kdeSupport: async () => ({
        status: "error",
        available: false,
        message: "KDE denied",
        protocolVersion: 1,
        feedbackAvailable: false,
      }),
    }),
    /KDE denied/,
  );
  for (const status of ["error", "update-required"] as const) {
    await assert.rejects(
      captureWaylandAppShot(false, {
        ...dependencies,
        hyprlandSupport: async () => ({
          status,
          message: "Hyprland unavailable installed helper",
          feedbackAvailable: false,
        }),
      }),
      /unavailable installed helper/,
    );
  }
  await assert.rejects(
    captureWaylandAppShot(false, {
      ...dependencies,
      kdeSupport: async () => {
        throw new Error("transport failure");
      },
    }),
    /transport failure/,
  );
  assert.equal(portalCalls, 4);
});

it("KDE/Hyprland AX identities retain observed frame/client geometry but not incompatible window IDs", () => {
  assert.deepEqual(nativeWaylandAppShotIdentity(nativeWaylandFixture), {
    platform: "linux",
    matchMode: "wayland",
    pid: 10,
    windowTitle: "Notes",
    bounds: { x: 400, y: 100, width: 900, height: 600 },
    clientBounds: { x: 405, y: 130, width: 890, height: 565 },
  });
  for (const processId of [0, -1, 1.5, NaN])
    assert.equal(
      nativeWaylandAppShotIdentity({
        ...nativeWaylandFixture,
        window: { ...nativeWaylandFixture.window, processId },
      }),
      undefined,
    );
  assert.equal(
    nativeWaylandAppShotIdentity({
      ...nativeWaylandFixture,
      window: { ...nativeWaylandFixture.window, title: "  " },
    }),
    undefined,
  );
  assert.equal(
    nativeWaylandAppShotIdentity({
      ...nativeWaylandFixture,
      window: undefined,
    }),
    undefined,
  );
  assert.doesNotMatch(
    nativeWaylandAppShotDraft(
      "KDE",
      { ...nativeWaylandFixture, window: undefined },
      true,
      { text: "Unmatched secret", truncated: false },
    ).context,
    /Unmatched secret/,
  );
});

it("uses ready GNOME capture without a portal fallback, even on capture denial", async () => {
  let portalCalls = 0;
  const dependencies = {
    gnomeSupport: async () => ({ status: "ready" as const }),
    captureGnome: async () => ({ png: Buffer.from([1]), width: 1, height: 1 }),
    capturePortal: async () => {
      portalCalls++;
      return undefined;
    },
  };
  assert.match(
    (await captureWaylandAppShot(false, dependencies))!.context,
    /GNOME window/,
  );
  assert.equal(portalCalls, 0);
  await assert.rejects(
    captureWaylandAppShot(false, {
      ...dependencies,
      captureGnome: async () => {
        throw new Error("permission denied");
      },
    }),
    /permission denied/,
  );
  assert.equal(portalCalls, 0);
});

it("GNOME absence can select a portal, but denied preflight never does", async () => {
  let portalCalls = 0;
  const dependencies = {
    gnomeSupport: async () => ({ status: "extension-unavailable" as const }),
    captureGnome: async () => {
      throw new Error("unexpected capture");
    },
    capturePortal: async () => {
      portalCalls++;
      return { png: Buffer.from([1]), width: 1, height: 1 };
    },
  };
  assert.match(
    (await captureWaylandAppShot(true, dependencies))!.context,
    /no verified application/,
  );
  assert.equal(portalCalls, 1);
  await assert.rejects(
    captureWaylandAppShot(false, {
      ...dependencies,
      gnomeSupport: async () => {
        throw new Error("denied");
      },
    }),
    /denied/,
  );
  assert.equal(portalCalls, 1);
});

it("GNOME retains observed position while Niri never promotes placeholder origins", async () => {
  const pixels = { png: Buffer.from([1]), width: 1, height: 1 };
  const gnome = {
    ...pixels,
    window: {
      title: "Notes",
      appName: "Editor",
      appIdentifier: "test.editor",
      processId: 10,
      bounds: { x: 500, y: 80, width: 900, height: 600 },
      accessibilityBoundsReliable: true,
    },
  };
  assert.deepEqual(gnomeAppShotIdentity(gnome), {
    platform: "linux",
    matchMode: "wayland",
    pid: 10,
    windowTitle: "Notes",
    bounds: { x: 500, y: 80, width: 900, height: 600 },
  });
  assert.equal(
    gnomeAppShotIdentity({
      ...gnome,
      window: { ...gnome.window, processId: 0 },
    }),
    undefined,
  );
  assert.equal(gnomeAppShotIdentity(pixels), undefined);
  const niri = {
    ...pixels,
    window: {
      id: 0,
      pid: 10,
      title: "Notes",
      appId: "test.editor",
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      accessibilityBoundsReliable: false as const,
    },
  };
  assert.deepEqual(niriAppShotIdentity(niri), {
    platform: "linux",
    matchMode: "wayland",
    windowId: 0,
    pid: 10,
    windowTitle: "Notes",
    bounds: { width: 900, height: 600 },
  });
  assert.equal(
    niriAppShotIdentity({ ...niri, window: { ...niri.window, pid: null } }),
    undefined,
  );
  let textReads = 0;
  const dependencies = {
    gnomeSupport: async () => ({ status: "ready" as const }),
    captureGnome: async () => gnome,
    capturePortal: async () => {
      throw new Error("unexpected portal");
    },
    readGnomeAccessibility: async () => {
      textReads++;
      return { text: "Captured text", truncated: true };
    },
  };
  assert.match(
    (await captureWaylandAppShot(false, dependencies))!.context,
    /not requested/,
  );
  assert.equal(textReads, 0);
  assert.match(
    (await captureWaylandAppShot(true, dependencies))!.context,
    /read-only, truncated.*Captured text/,
  );
  assert.equal(textReads, 1);
  await captureWaylandAppShot(true, {
    ...dependencies,
    captureGnome: async () => pixels,
  });
  assert.equal(textReads, 1);
  assert.match(
    niriAppShotDraft(niri, true, { text: "Niri text", truncated: false })
      .context,
    /Niri text/,
  );
  assert.doesNotMatch(
    niriAppShotDraft(pixels, true, { text: "Wrong window", truncated: false })
      .context,
    /Wrong window/,
  );
});

it("GNOME draft uses only supplied metadata and never fabricates accessibility", () => {
  const pixels = { png: Buffer.from([1]), width: 1, height: 1 };
  assert.match(gnomeAppShotDraft(pixels, true).context, /metadata is omitted/);
  const result = gnomeAppShotDraft(
    {
      ...pixels,
      window: {
        title: "Notes\nname",
        appName: "Editor",
        appIdentifier: "test.editor",
        processId: 10,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        accessibilityBoundsReliable: true,
      },
    },
    true,
  );
  assert.match(result.context, /Notes name.*Editor/);
  assert.match(result.context, /Screenshot only/);
  assert.match(result.context, /not permission to control/);
});

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
  assert.match(draft.context, /Accessibility text was unavailable/);
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

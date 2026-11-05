import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_SHOT_MAX_ACCESSIBILITY_APPS,
  APP_SHOT_MAX_ACCESSIBILITY_WINDOWS,
  readAppShotAccessibilityWithApi,
  type AppShotAccessibilityApi,
  type AppShotAccessibilityElement,
} from "../src/main/app-shot-accessibility.js";
import {
  isAppShotAccessibilityIdentity,
  isAppShotIdentity,
  readCapturedAppShotAccessibility,
  type AppShotAccessibilityBounds,
  type AppShotLinuxCaptureIdentity,
  type AppShotNativeChild,
} from "../src/main/app-shot-native-capture.js";

const identity: AppShotLinuxCaptureIdentity = {
  platform: "linux",
  matchMode: "wayland",
  windowId: 0,
  pid: 471,
  windowTitle: "Synthetic document",
  bounds: { width: 1200, height: 800 },
};

function windowFixture(
  name: string | null = identity.windowTitle,
  bounds: AppShotAccessibilityBounds | null = identity.bounds,
) {
  const state = {
    name,
    bounds,
    treeReads: 0,
    pid: identity.pid,
    bus: ":1.471",
    path: "/org/a11y/atspi/accessible/42",
    defunct: false,
  };
  const window: AppShotAccessibilityElement = {
    get pid() {
      return state.pid;
    },
    get raw() {
      return {
        bus_name: state.bus,
        object_path: state.path,
        atspi_defunct: state.defunct,
      };
    },
    get name() {
      return state.name;
    },
    get bounds() {
      return state.bounds;
    },
    tree: async () => {
      state.treeReads++;
      return {
        name: "Synthetic text",
        children: [],
        selector: "not exported",
        actions: ["press"],
      };
    },
  };
  return { state, window };
}

function appFixture(
  windows: AppShotAccessibilityElement[],
  pid = identity.pid,
) {
  return {
    pid,
    children: async (): Promise<readonly AppShotAccessibilityElement[]> =>
      windows.map((window) => ({ ...window, pid })),
    asElement: () => {
      throw new Error("Linux must not use a foreground root");
    },
  };
}

function fixture() {
  const target = windowFixture();
  const app = appFixture([target.window]);
  const counts = { list: 0, byPid: 0 };
  const api: AppShotAccessibilityApi = {
    foreground: async () => {
      throw new Error("Linux must not query the foreground");
    },
    byPid: async (pid, options) => {
      counts.byPid++;
      assert.equal(pid, identity.pid);
      assert.equal(options.timeout, 0);
      return app;
    },
    list: async () => {
      counts.list++;
      throw new Error("A nonempty PID lookup must not enumerate apps");
    },
  };
  return { target, app, api, counts };
}

describe("trusted Linux accessibility identity", () => {
  it("accepts logical size without fabricating position and keeps native capture contracts unchanged", () => {
    assert.equal(isAppShotAccessibilityIdentity(identity), true);
    assert.equal(
      isAppShotAccessibilityIdentity({ ...identity, windowId: undefined }),
      true,
    );
    assert.equal(isAppShotIdentity(identity), false);
    assert.equal(
      isAppShotAccessibilityIdentity({
        ...identity,
        bounds: { ...identity.bounds, x: -800, y: 20 },
        clientBounds: { width: 1180, height: 760 },
      }),
      true,
    );
    assert.equal(
      isAppShotAccessibilityIdentity({
        ...identity,
        matchMode: "screen-bounds",
        bounds: { ...identity.bounds, x: -800, y: 20 },
      }),
      true,
    );
  });

  it("rejects portal-like or malformed metadata before invoking an API", async () => {
    for (const value of [
      {},
      { ...identity, pid: 0 },
      { ...identity, pid: null },
      { ...identity, windowId: -1 },
      { ...identity, windowTitle: " " },
      { ...identity, windowTitle: "x".repeat(4097) },
      { ...identity, matchMode: undefined },
      { ...identity, matchMode: "screen-bounds" },
      { ...identity, bounds: { width: 0, height: 10 } },
      { ...identity, bounds: { width: Infinity, height: 10 } },
      { ...identity, bounds: { ...identity.bounds, x: 0 } },
      { ...identity, bounds: { ...identity.bounds, x: NaN, y: 0 } },
      { ...identity, clientBounds: { width: -1, height: 10 } },
    ]) {
      const fake = fixture();
      assert.equal(isAppShotAccessibilityIdentity(value), false);
      assert.equal(
        await readAppShotAccessibilityWithApi(
          fake.api,
          value as AppShotLinuxCaptureIdentity,
        ),
        undefined,
      );
      assert.equal(fake.counts.byPid, 0);
      assert.equal(fake.counts.list, 0);
    }
  });
});

describe("PID-scoped Linux AT-SPI text", () => {
  it("matches unique title and logical dimensions despite missing or sentinel Wayland position", async () => {
    for (const position of [
      {},
      { x: 0, y: 0 },
      { x: -2147483648, y: -2147483648 },
    ]) {
      const fake = fixture();
      fake.target.state.bounds = { ...identity.bounds, ...position };
      const result = await readAppShotAccessibilityWithApi(fake.api, identity);
      assert.deepEqual(result, { text: "Synthetic text", truncated: false });
      assert.equal(fake.target.state.treeReads, 1);
      assert.equal(fake.counts.list, 0);
      assert.doesNotMatch(JSON.stringify(result), /selector|actions|press/);
    }
  });

  it("accepts frame or client dimensions within T3's two-pixel tolerance", async () => {
    const fake = fixture();
    fake.target.state.bounds = { width: 1182, height: 758 };
    assert.deepEqual(
      await readAppShotAccessibilityWithApi(fake.api, {
        ...identity,
        clientBounds: { width: 1180, height: 760 },
      }),
      { text: "Synthetic text", truncated: false },
    );
  });

  it("normalizes only T3's leading Wayland terminal spinner", async () => {
    const fake = fixture();
    fake.target.state.name = " ⠙ Synthetic document ";
    assert.ok(await readAppShotAccessibilityWithApi(fake.api, identity));
    fake.target.state.name = "⠙";
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, {
        ...identity,
        windowTitle: "⠋",
      }),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 1);
  });

  it("rejects mismatched title, size, PID and unavailable metadata without app-list fallback", async () => {
    for (const change of [
      { name: "Another document" },
      { bounds: null },
      { bounds: { width: 1203, height: 800 } },
      { bounds: { width: 1200, height: NaN } },
    ]) {
      const fake = fixture();
      Object.assign(fake.target.state, change);
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 0);
      assert.equal(fake.counts.list, 0);
    }
    const fake = fixture();
    fake.app.pid++;
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
    assert.equal(fake.counts.list, 0);
  });

  it("fails closed on equal title/size windows, even if one reports active", async () => {
    const fake = fixture();
    const second = windowFixture();
    fake.app.children = async () => [
      { ...fake.target.window, active: true },
      second.window,
    ];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
    assert.equal(second.state.treeReads, 0);
    assert.equal(fake.counts.list, 0);
  });

  it("requires position in screen-bounds mode and leaves macOS full-bound matching strict", async () => {
    const fake = fixture();
    fake.target.state.bounds = { ...identity.bounds, x: 0, y: 0 };
    for (const captured of [
      { ...identity, matchMode: "screen-bounds" as const },
      { ...identity, platform: "darwin" as const, windowId: 1 },
    ]) {
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, {
          ...captured,
          bounds: { ...identity.bounds, x: 40, y: 30 },
        }),
        undefined,
      );
    }
    assert.equal(fake.target.state.treeReads, 0);
  });

  it("discards text when PID/title/dimensions change during the read", async () => {
    for (const mutate of [
      (fake: ReturnType<typeof fixture>) => fake.app.pid++,
      (fake: ReturnType<typeof fixture>) => {
        fake.target.state.name = "Changed";
      },
      (fake: ReturnType<typeof fixture>) => {
        fake.target.state.bounds = { width: 10, height: 10 };
      },
    ]) {
      const fake = fixture();
      fake.target.window.tree = async () => {
        mutate(fake);
        return { name: "Must not escape", children: [] };
      };
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
    }
  });

  it("rejects PID drift while enumerating children before reading any tree", async () => {
    const fake = fixture();
    fake.app.children = async () => {
      fake.app.pid++;
      return [fake.target.window];
    };
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
  });
});

describe("PID-scoped unnamed GTK4 windows", () => {
  it("accepts a unique unnamed bounds match within the verified positive PID", async () => {
    for (const name of [null, "", " "]) {
      const fake = fixture();
      fake.target.state.name = name;
      assert.deepEqual(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        { text: "Synthetic text", truncated: false },
      );
      assert.equal(fake.target.state.treeReads, 1);
      assert.equal(fake.counts.list, 0);
    }
  });

  it("prefers a matching named window to unnamed frames of the same dimensions", async () => {
    const fake = fixture();
    const unnamed = windowFixture(null);
    fake.app.children = async () => [unnamed.window, fake.target.window];
    assert.ok(await readAppShotAccessibilityWithApi(fake.api, identity));
    assert.equal(fake.target.state.treeReads, 1);
    assert.equal(unnamed.state.treeReads, 0);
  });

  it("rejects duplicate unnamed windows and does not rescue ambiguous named matches", async () => {
    for (const named of [true, false]) {
      const fake = fixture();
      const other = windowFixture(named ? identity.windowTitle : null);
      const unnamed = windowFixture(null);
      if (!named) fake.target.state.name = null;
      fake.app.children = async () => [
        fake.target.window,
        other.window,
        unnamed.window,
      ];
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 0);
      assert.equal(other.state.treeReads, 0);
      assert.equal(unnamed.state.treeReads, 0);
    }
  });

  it("requires matching size and the same trusted PID before reading an unnamed tree", async () => {
    for (const mismatch of ["pid", "size"] as const) {
      const fake = fixture();
      fake.target.state.name = null;
      if (mismatch === "pid") fake.app.pid++;
      else fake.target.state.bounds = { width: 40, height: 20 };
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 0);
      assert.equal(fake.counts.list, 0);
    }
  });

  it("never accepts unnamed matches from App.list, even if a listed PID equals the requested PID", async () => {
    const fake = fixture();
    fake.target.state.name = null;
    fake.api.byPid = async () => appFixture([]);
    fake.api.list = async () => [fake.app];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
  });

  it("rechecks unnamed metadata after reading and discards a newly named window", async () => {
    const fake = fixture();
    fake.target.state.name = null;
    fake.target.window.tree = async () => {
      fake.target.state.name = "Different window";
      return { name: "Must not escape", children: [] };
    };
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
  });
});

describe("fresh Linux AX object postvalidation", () => {
  it("re-queries the retained owner's metadata and accepts the same unique bus/path/PID", async () => {
    const fake = fixture();
    let childReads = 0;
    fake.app.children = async () => {
      childReads++;
      return [{ ...fake.target.window }];
    };
    assert.deepEqual(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      {
        text: "Synthetic text",
        truncated: false,
      },
    );
    assert.equal(childReads, 2);
    assert.equal(fake.target.state.treeReads, 1);
    assert.equal(fake.counts.list, 0);
  });

  it("does not mistake cached getters for current title or dimensions", async () => {
    for (const change of [
      { name: "New title" },
      { bounds: { width: 30, height: 20 } },
    ]) {
      const fake = fixture();
      const cached = { ...fake.target.window };
      let reads = 0;
      fake.app.children = async () => [
        reads++ === 0 ? cached : { ...cached, ...change },
      ];
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(cached.name, identity.windowTitle);
      assert.deepEqual(cached.bounds, identity.bounds);
      assert.equal(fake.target.state.treeReads, 1);
    }
  });

  it("rejects fresh replacement, missing identity, defunct state or owner PID drift", async () => {
    for (const change of [
      {
        raw: {
          bus_name: ":1.999",
          object_path: "/org/a11y/atspi/accessible/42",
        },
      },
      {
        raw: {
          bus_name: ":1.471",
          object_path: "/org/a11y/atspi/accessible/99",
        },
      },
      {
        raw: {
          bus_name: ":1.471",
          object_path: "/org/a11y/atspi/accessible/42",
          atspi_defunct: true,
        },
      },
      { raw: undefined },
      { raw: {} },
      { pid: null },
      { pid: identity.pid + 1 },
    ]) {
      const fake = fixture();
      let reads = 0;
      fake.app.children = async () => [
        { ...fake.target.window, ...(reads++ > 0 ? change : {}) },
      ];
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 1);
    }
  });

  it("requires native identity before reading any Linux tree", async () => {
    for (const change of [
      { raw: undefined },
      { raw: {} },
      { raw: { bus_name: "org.example.WellKnown", object_path: "/window" } },
      { raw: { bus_name: ":1.471", object_path: "" } },
      { pid: null },
      { pid: identity.pid + 1 },
    ]) {
      const fake = fixture();
      fake.app.children = async () => [{ ...fake.target.window, ...change }];
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 0);
    }
  });

  it("rejects missing, ambiguous, oversized or failed fresh child lists without reading another tree", async () => {
    for (const result of [
      "missing",
      "ambiguous",
      "oversized",
      "failed",
    ] as const) {
      const fake = fixture();
      let reads = 0;
      fake.app.children = async () => {
        if (reads++ === 0) return [{ ...fake.target.window }];
        if (result === "failed") throw new Error("Fresh AX unavailable");
        if (result === "missing") return [];
        return Array.from(
          {
            length:
              result === "ambiguous"
                ? 2
                : APP_SHOT_MAX_ACCESSIBILITY_WINDOWS + 1,
          },
          () => ({ ...fake.target.window }),
        );
      };
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 1);
      assert.equal(fake.counts.list, 0);
    }
  });

  it("retains unnamed GTK4 matching mode during the fresh query", async () => {
    const fake = fixture();
    fake.target.state.name = null;
    let reads = 0;
    fake.app.children = async () => [
      {
        ...fake.target.window,
        name: reads++ === 0 ? null : identity.windowTitle,
      },
    ];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 1);
  });

  it("rejects an unnamed match if a preferred named match appears during the tree read", async () => {
    const fake = fixture();
    fake.target.state.name = null;
    const named = windowFixture();
    let reads = 0;
    fake.app.children = async () =>
      reads++ === 0
        ? [{ ...fake.target.window }]
        : [{ ...fake.target.window }, { ...named.window }];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 1);
    assert.equal(named.state.treeReads, 0);
  });

  it("keeps postvalidation inside the same 3-second deadline", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fixture();
    let entered = () => {};
    let finish = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    fake.app.children = async () => {
      if (reads++ > 0) {
        entered();
        await blocked;
      }
      return [{ ...fake.target.window }];
    };
    const read = readAppShotAccessibilityWithApi(fake.api, identity);
    await started;
    context.mock.timers.tick(3000);
    assert.equal(await read, undefined);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fake.target.state.treeReads, 1);
    assert.equal(fake.counts.list, 0);
  });
});

describe("bounded Flatpak proxy metadata fallback", () => {
  class SyntheticAppNotFoundError extends Error {
    selector = `application[pid=${identity.pid}]`;
  }
  const isAppNotFoundError = (error: unknown) =>
    error instanceof SyntheticAppNotFoundError &&
    error.selector === `application[pid=${identity.pid}]`;

  it("lists apps only after an empty/missing PID lookup or a typed app miss and reads only the unique matching window", async () => {
    for (const missing of ["empty", "missing", "typed-miss"] as const) {
      const fake = fixture();
      const unrelated = windowFixture("Unrelated window");
      fake.api.byPid = async () => {
        if (missing === "typed-miss")
          throw new SyntheticAppNotFoundError("PID not in AT-SPI");
        if (missing === "missing") return undefined;
        return {
          ...fake.app,
          children: async () => [],
        };
      };
      fake.api.list = async () => [
        appFixture([unrelated.window], 800),
        appFixture([fake.target.window], 801),
      ];
      assert.deepEqual(
        await readAppShotAccessibilityWithApi(
          fake.api,
          identity,
          isAppNotFoundError,
        ),
        { text: "Synthetic text", truncated: false },
      );
      assert.equal(fake.target.state.treeReads, 1);
      assert.equal(unrelated.state.treeReads, 0);
    }
  });

  it("does not use app-list fallback after denied, disabled, platform or unknown lookup errors", async () => {
    for (const name of [
      "PermissionDeniedError",
      "AccessibilityNotEnabledError",
      "PlatformError",
      "Error",
      "SelectorNotMatchedError",
    ]) {
      const fake = fixture();
      fake.api.byPid = async () => {
        const error = new Error("Lookup unavailable");
        error.name = name;
        throw error;
      };
      assert.equal(
        await readAppShotAccessibilityWithApi(
          fake.api,
          identity,
          isAppNotFoundError,
        ),
        undefined,
      );
      assert.equal(fake.counts.list, 0);
      assert.equal(fake.target.state.treeReads, 0);
    }
  });

  it("requires a native typed-miss classifier rather than treating arbitrary rejection as absence", async () => {
    const fake = fixture();
    fake.api.byPid = async () => {
      throw new SyntheticAppNotFoundError("Unknown without classifier");
    };
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.counts.list, 0);
  });

  it("does not treat a stale handle or another PID's typed miss as this PID being absent", async () => {
    for (const selector of ["handle:123", "application[pid=472]"]) {
      const fake = fixture();
      fake.api.byPid = async () => {
        const error = new SyntheticAppNotFoundError("Unrelated miss");
        error.selector = selector;
        throw error;
      };
      assert.equal(
        await readAppShotAccessibilityWithApi(
          fake.api,
          identity,
          isAppNotFoundError,
        ),
        undefined,
      );
      assert.equal(fake.counts.list, 0);
      assert.equal(fake.target.state.treeReads, 0);
    }
  });

  it("does not treat a failed PID children enumeration as an empty lookup", async () => {
    const fake = fixture();
    fake.app.children = async () => {
      throw new Error("Unavailable PID windows");
    };
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.counts.list, 0);
    assert.equal(fake.target.state.treeReads, 0);
  });

  it("does not use cross-app fallback for macOS or Windows", async () => {
    const fake = fixture();
    fake.api.byPid = async () => appFixture([]);
    fake.api.foreground = async () => undefined;
    for (const platform of ["darwin", "win32"] as const) {
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, {
          ...identity,
          platform,
          windowId: 1,
          bounds: { ...identity.bounds, x: 0, y: 0 },
        }),
        undefined,
      );
    }
    assert.equal(fake.counts.list, 0);
  });

  it("rejects ambiguous matches across apps without reading either tree", async () => {
    const fake = fixture();
    const other = windowFixture();
    fake.api.byPid = async () => appFixture([]);
    fake.api.list = async () => [
      appFixture([fake.target.window], 800),
      appFixture([other.window], 801),
    ];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
    assert.equal(other.state.treeReads, 0);
  });

  it("fails closed on incomplete metadata enumeration instead of declaring a partial list unique", async () => {
    const fake = fixture();
    fake.api.byPid = async () => appFixture([]);
    fake.api.list = async () => [
      appFixture([fake.target.window], 800),
      {
        ...appFixture([], 801),
        children: async () => {
          throw new Error("Unavailable");
        },
      },
    ];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
  });

  it("rejects unreadable top-level metadata without harvesting any tree", async () => {
    const fake = fixture();
    fake.app.children = async () => [
      fake.target.window,
      {
        ...fake.target.window,
        get name(): string {
          throw new Error("Unavailable metadata");
        },
      },
    ];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
  });

  it("bounds application enumeration before touching children", async () => {
    const fake = fixture();
    let childrenReads = 0;
    fake.api.byPid = async () => appFixture([]);
    fake.api.list = async () =>
      Array.from({ length: APP_SHOT_MAX_ACCESSIBILITY_APPS + 1 }, () => ({
        ...fake.app,
        children: async () => {
          childrenReads++;
          return [];
        },
      }));
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(childrenReads, 0);
  });

  it("bounds total window metadata across apps and PID-scoped windows before reading trees", async () => {
    for (const fallback of [true, false]) {
      const fake = fixture();
      const windows = Array.from(
        { length: APP_SHOT_MAX_ACCESSIBILITY_WINDOWS },
        () => windowFixture("Unrelated").window,
      );
      if (fallback) {
        fake.api.byPid = async () => appFixture([]);
        fake.api.list = async () => [
          appFixture(windows, 800),
          appFixture([fake.target.window], 801),
        ];
      } else fake.app.children = async () => [...windows, fake.target.window];
      assert.equal(
        await readAppShotAccessibilityWithApi(fake.api, identity),
        undefined,
      );
      assert.equal(fake.target.state.treeReads, 0);
    }
  });

  it("rejects proxy PID drift during metadata enumeration", async () => {
    const fake = fixture();
    const proxy = appFixture([fake.target.window], 800);
    proxy.children = async () => {
      proxy.pid++;
      return [fake.target.window];
    };
    fake.api.byPid = async () => appFixture([]);
    fake.api.list = async () => [proxy];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    assert.equal(fake.target.state.treeReads, 0);
  });

  it("uses the 3-second AX deadline and fences late metadata before it can start a tree read", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fixture();
    let resolveApp: (app: typeof fake.app) => void = () => {};
    const pendingApp = new Promise<typeof fake.app>((resolve) => {
      resolveApp = resolve;
    });
    fake.api.byPid = () => pendingApp;
    const read = readAppShotAccessibilityWithApi(fake.api, identity);
    context.mock.timers.tick(3000);
    assert.equal(await read, undefined);
    resolveApp(fake.app);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fake.target.state.treeReads, 0);
    assert.equal(fake.counts.list, 0);
  });

  for (const stage of ["list", "children", "tree"] as const) {
    it(`fences late ${stage} completion after the AX deadline`, async (context) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const fake = fixture();
      let unblock = () => {};
      let entered = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const wait = async () => {
        entered();
        await blocked;
      };
      let laterChildren = 0;
      if (stage === "list") {
        fake.api.byPid = async () => appFixture([]);
        fake.api.list = async () => {
          await wait();
          return [
            {
              ...fake.app,
              children: async () => {
                laterChildren++;
                return [fake.target.window];
              },
            },
          ];
        };
      } else if (stage === "children") {
        fake.api.byPid = async () => appFixture([]);
        fake.api.list = async () => [
          {
            ...fake.app,
            children: async () => {
              await wait();
              return [fake.target.window];
            },
          },
        ];
      } else {
        fake.target.window.tree = async () => {
          fake.target.state.treeReads++;
          await wait();
          return { name: "Late text must not escape", children: [] };
        };
      }
      const read = readAppShotAccessibilityWithApi(fake.api, identity);
      await started;
      context.mock.timers.tick(3000);
      assert.equal(await read, undefined);
      unblock();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(laterChildren, 0);
      assert.equal(fake.target.state.treeReads, stage === "tree" ? 1 : 0);
    });
  }
});

describe("isolated Linux accessibility worker contract", () => {
  it("forwards only the trusted Linux identity and stops its owned child on cancellation", async () => {
    let onMessage: (value: unknown) => void = () => {};
    let onExit = () => {};
    const requests: unknown[] = [];
    const signals: string[] = [];
    const child: AppShotNativeChild = {
      onMessage: (listener) => {
        onMessage = listener;
      },
      onExit: (listener) => {
        onExit = listener;
      },
      send: (request, callback) => {
        requests.push(request);
        callback();
      },
      kill: (signal = "SIGTERM") => {
        signals.push(signal);
        onExit();
      },
    };
    const abort = new AbortController();
    const pending = readCapturedAppShotAccessibility(identity, {
      signal: abort.signal,
      fork: (operation) => {
        assert.equal(operation, "accessibility");
        return child;
      },
    });
    onMessage("ready");
    assert.deepEqual(requests, [{ identity }]);
    abort.abort();
    onMessage({
      type: "result",
      value: { text: "Late text", truncated: false },
    });
    assert.equal(await pending, undefined);
    assert.deepEqual(signals, ["SIGTERM"]);
  });
});

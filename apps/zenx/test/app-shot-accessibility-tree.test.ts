import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appShotAccessibleElements,
  readAppShotAccessibilityWithApi,
  type AppShotAccessibilityElement,
} from "../src/main/app-shot-accessibility.js";
import {
  APP_SHOT_ACCESSIBILITY_LIMITS,
  APP_SHOT_MAX_DEPTH,
  APP_SHOT_MAX_NODES,
  APP_SHOT_MAX_TEXT,
  parseAppShotAccessibility,
  serializeAppShotTree,
  type AppShotAccessibilityPayload,
  type AppShotCaptureIdentity,
  type AppShotElementNode,
} from "../src/main/app-shot-native-contract.js";
import {
  readCapturedAppShotAccessibility,
  type AppShotNativeChild,
} from "../src/main/app-shot-native-capture.js";
import {
  createAppShotService,
  gnomeAppShotDraft,
  nativeWaylandAppShotDraft,
  niriAppShotDraft,
  windowsAppShotDraft,
} from "../src/main/app-shot.js";

const imageSize = { width: 1200, height: 800 };
const identity: AppShotCaptureIdentity = {
  platform: "darwin",
  windowId: 42,
  pid: 471,
  windowTitle: "Synthetic document",
  bounds: { x: -100, y: 40, ...imageSize },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n8kAAAAASUVORK5CYII=",
  "base64",
);

function element(
  overrides: Partial<AppShotAccessibilityElement> = {},
): AppShotAccessibilityElement {
  return {
    name: null,
    role: "group",
    bounds: null,
    children: async () => [],
    ...overrides,
  };
}
function rich(payload: AppShotAccessibilityPayload | undefined) {
  assert.equal(payload?.format, "element-tree");
  return payload as Extract<
    AppShotAccessibilityPayload,
    { format: "element-tree" }
  >;
}
function leaf(overrides: Partial<AppShotElementNode> = {}): AppShotElementNode {
  return {
    role: "group",
    name: null,
    value: null,
    description: null,
    bounds: null,
    state: {},
    actions: [],
    children: [],
    ...overrides,
  };
}
function payload(
  root = leaf(),
): Extract<AppShotAccessibilityPayload, { format: "element-tree" }> {
  return {
    format: "element-tree",
    coordinateSpace: "captured-image",
    imageSize,
    truncated: false,
    root: { ...root, bounds: { x: 0, y: 0, ...imageSize } },
  };
}
function readMatched(root: AppShotAccessibilityElement) {
  const window = {
    ...root,
    name: identity.windowTitle,
    bounds: identity.bounds,
  };
  const app = {
    pid: identity.pid,
    asElement: () => window,
    children: async () => [window],
  };
  return readAppShotAccessibilityWithApi(
    { byPid: async () => app, foreground: async () => app },
    identity,
    undefined,
    imageSize,
  );
}

describe("read-only semantic accessibility traversal", () => {
  it("retains descriptions, nonvisible state and advertised names without exporting raw/native targets", async () => {
    let nativeBoundsReads = 0;
    const child = element({
      role: "check_box",
      name: "  Choice\0 ",
      value: "Choice",
      description: "  Outside the visible pixels  ",
      active: false,
      busy: true,
      editable: true,
      focused: true,
      selected: true,
      enabled: false,
      visible: false,
      checked: "mixed",
      expanded: false,
      actions: [" press\0 ", "press", "focus"],
      raw: { secret_native_id: "PRIVATE", object_path: "/PRIVATE" },
      pid: 99,
    });
    Object.defineProperty(child, "bounds", {
      get() {
        nativeBoundsReads++;
        throw new Error("No native coordinates allowed");
      },
    });
    const result = rich(
      await appShotAccessibleElements(
        element({ name: "Window", children: async () => [child] }),
        "darwin",
        imageSize,
      ),
    );
    assert.deepEqual(result.root.bounds, { x: 0, y: 0, ...imageSize });
    assert.equal(nativeBoundsReads, 0);
    assert.deepEqual(
      result.root.children[0],
      leaf({
        role: "check_box",
        name: "Choice",
        description: "Outside the visible pixels",
        state: {
          busy: true,
          editable: true,
          focused: true,
          selected: true,
          enabled: false,
          visible: false,
          checked: "mixed",
          expanded: false,
        },
        actions: ["press", "focus"],
      }),
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE|object_path|raw|pid|target|selector|handle/,
    );
    assert.ok(parseAppShotAccessibility(result, imageSize));
  });

  it("preserves role-only trees and emits null descendant bounds on every platform", async () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const result = rich(
        await appShotAccessibleElements(
          element({ children: async () => [element({ role: "separator" })] }),
          platform,
          imageSize,
        ),
      );
      assert.equal(result.root.children[0]?.role, "separator");
      assert.equal(result.root.children[0]?.bounds, null);
      assert.equal(result.truncated, false);
    }
  });

  it("uses flat text only when captured image dimensions are unavailable", async () => {
    assert.deepEqual(
      await appShotAccessibleElements(
        element({ name: "Only text", value: "Value" }),
        "linux",
        undefined,
      ),
      { format: "flat-text", text: "Only text\nValue", truncated: false },
    );
    assert.equal(
      await appShotAccessibleElements(element(), "linux", undefined),
      undefined,
    );
  });

  it("bounds description, role and action names, trims NUL and preserves Unicode pairs", async () => {
    const result = rich(
      await appShotAccessibleElements(
        element({
          role: "r".repeat(99) + "😀",
          description: "d".repeat(1999) + "😀",
          actions: [
            "a".repeat(99) + "😀",
            ...Array.from({ length: 40 }, (_, i) => `action${i}`),
          ],
        }),
        "win32",
        imageSize,
      ),
    );
    assert.equal(result.root.role.length, 99);
    assert.equal(result.root.description?.length, 1999);
    assert.equal(result.root.actions[0]?.length, 99);
    assert.equal(
      result.root.actions.length,
      APP_SHOT_ACCESSIBILITY_LIMITS.actions,
    );
    assert.equal(result.truncated, true);
    assert.ok(parseAppShotAccessibility(result, imageSize));
    const deduped = rich(
      await appShotAccessibleElements(
        element({ name: " Same\0", value: "Same", description: "Same" }),
        "win32",
        imageSize,
      ),
    );
    assert.equal(deduped.root.name, "Same");
    assert.equal(deduped.root.value, null);
    assert.equal(deduped.root.description, null);
  });

  it("omits known macOS/Linux secure subtrees before reading their strings or children", async () => {
    for (const [platform, raw] of [
      ["darwin", { ax_role: "AXSecureTextField" }],
      ["darwin", { ax_subrole: "AXSecureTextField" }],
      ["linux", { atspi_role: "password text" }],
      ["linux", { atspi_role: "role_num:40" }],
    ] as const) {
      const secure = element({ raw });
      for (const key of ["name", "value", "description", "children"])
        Object.defineProperty(secure, key, {
          get() {
            throw new Error("Known secure subtree must not be visited");
          },
        });
      const result = rich(
        await appShotAccessibleElements(
          element({
            name: "Visible",
            children: async () => [secure, element({ name: "Safe" })],
          }),
          platform,
          imageSize,
        ),
      );
      assert.equal(result.root.children.length, 1);
      assert.equal(result.root.children[0]?.name, "Safe");
      assert.equal(result.truncated, true);
      assert.doesNotMatch(
        JSON.stringify(result),
        /SecureTextField|password text|role_num/,
      );
    }
  });

  it("returns screenshot-only for throwing semantic getters or child reads", async () => {
    for (const key of [
      "value",
      "description",
      "actions",
      "busy",
      "raw",
      "children",
    ]) {
      const root = element();
      Object.defineProperty(root, key, {
        enumerable: true,
        get() {
          throw new Error("Private provider error");
        },
      });
      // Spread would itself access getters; keep them on a child of the matched window.
      assert.equal(
        await readMatched(element({ children: async () => [root] })),
        undefined,
      );
    }
    assert.equal(
      await readMatched(
        element({
          children: async () => {
            throw new Error("Private child failure");
          },
        }),
      ),
      undefined,
    );
  });

  it("stops at the node and depth budgets without recursive materialization", async () => {
    let visits = 0;
    const children = Array.from({ length: APP_SHOT_MAX_NODES + 20 }, () => {
      const node = element({ children: async () => [] });
      Object.defineProperty(node, "name", {
        get() {
          visits++;
          return null;
        },
      });
      return node;
    });
    const wide = rich(
      await appShotAccessibleElements(
        element({ children: async () => children }),
        "win32",
        imageSize,
      ),
    );
    assert.equal(visits, APP_SHOT_MAX_NODES - 1);
    assert.equal(wide.truncated, true);
    assert.ok(serializeAppShotTree(wide)!.length <= APP_SHOT_MAX_TEXT);
    let childCalls = 0;
    const deep: AppShotAccessibilityElement = element({
      children: async () => {
        childCalls++;
        return [deep];
      },
    });
    const result = rich(
      await appShotAccessibleElements(deep, "win32", imageSize),
    );
    assert.equal(childCalls, APP_SHOT_MAX_DEPTH);
    assert.equal(result.truncated, true);
    assert.ok(parseAppShotAccessibility(result, imageSize));
  });

  it("prefers flat text when rich field or serialization budgets would lose more text", async () => {
    const fieldLimited = await appShotAccessibleElements(
      element({ name: "n".repeat(1100), value: "v".repeat(8100) }),
      "win32",
      imageSize,
    );
    assert.equal(fieldLimited?.format, "flat-text");
    if (fieldLimited?.format !== "flat-text") return;
    assert.equal(fieldLimited.text.length, 9201);
    assert.equal(fieldLimited.truncated, false);
    const children = Array.from({ length: 500 }, (_, i) =>
      element({ name: `Text ${i}` }),
    );
    const budgetLimited = await appShotAccessibleElements(
      element({ children: async () => children }),
      "win32",
      imageSize,
    );
    assert.equal(budgetLimited?.format, "flat-text");
    if (budgetLimited?.format !== "flat-text") return;
    assert.match(budgetLimited.text, /Text 499$/);
    assert.equal(budgetLimited.truncated, false);
    const flat = await appShotAccessibleElements(
      element({ value: "x".repeat(APP_SHOT_MAX_TEXT - 1) + "😀" }),
      "win32",
      imageSize,
    );
    assert.equal(flat?.format, "flat-text");
    if (flat?.format !== "flat-text") return;
    assert.equal(flat.text.length, APP_SHOT_MAX_TEXT - 1);
    assert.equal(flat.truncated, true);
  });

  it("does not let duplicate/overlapping text hide a truncated child name", async () => {
    const result = await appShotAccessibleElements(
      element({
        name: "A".repeat(2000),
        value: "A".repeat(2000),
        children: async () => [
          element({ name: "B".repeat(1490) + "LOST_TAIL!" }),
        ],
      }),
      "win32",
      imageSize,
    );
    assert.equal(result?.format, "flat-text");
    if (result?.format === "flat-text")
      assert.match(result.text, /LOST_TAIL!$/);
  });

  it("exhausts flat accumulation after a surrogate partial fit even across many later long values", async () => {
    const result = await appShotAccessibleElements(
      element({
        value: "x".repeat(APP_SHOT_MAX_TEXT - 1) + "😀",
        children: async () =>
          Array.from({ length: APP_SHOT_MAX_NODES - 1 }, (_, index) =>
            Object.defineProperty(element(), "value", {
              get() {
                return `later${index}` + "y".repeat(APP_SHOT_MAX_TEXT);
              },
            }),
          ),
      }),
      "win32",
      undefined,
    );
    assert.equal(result?.format, "flat-text");
    if (result?.format === "flat-text") {
      assert.equal(result.text, "x".repeat(APP_SHOT_MAX_TEXT - 1));
      assert.equal(result.truncated, true);
    }
  });

  it("keeps rich and flat whitespace cutoffs canonical for parent admission", async () => {
    const flat = await appShotAccessibleElements(
      element({ value: "a".repeat(APP_SHOT_MAX_TEXT - 1) + "\ntail" }),
      "win32",
      imageSize,
    );
    assert.equal(flat?.format, "flat-text");
    assert.ok(parseAppShotAccessibility(flat, imageSize));
    if (flat?.format === "flat-text")
      assert.equal(flat.text, "a".repeat(APP_SHOT_MAX_TEXT - 1));
    const tree = rich(
      await appShotAccessibleElements(
        element({
          role: "r".repeat(99) + " tail",
          description: "d".repeat(1999) + " tail",
        }),
        "win32",
        imageSize,
      ),
    );
    assert.equal(tree.root.role, "r".repeat(99));
    assert.equal(tree.root.description, "d".repeat(1999));
    assert.ok(parseAppShotAccessibility(tree, imageSize));
    for (const count of [100, 300]) {
      const escaped = await appShotAccessibleElements(
        element({
          children: async () =>
            Array.from({ length: count }, (_, i) =>
              element({ name: `Item ${i} \"\\\n` + "x".repeat(1000) }),
            ),
        }),
        "win32",
        imageSize,
      );
      assert.ok(parseAppShotAccessibility(escaped, imageSize));
    }
  });

  it("detects truncation across a whitespace run and canonicalizes malformed Unicode", async () => {
    const flat = await appShotAccessibleElements(
      element({ name: "A".repeat(1000) + " ".repeat(10) + "LOST" }),
      "win32",
      imageSize,
    );
    assert.equal(flat?.format, "flat-text");
    if (flat?.format === "flat-text") assert.match(flat.text, /LOST$/);
    assert.ok(parseAppShotAccessibility(flat, imageSize));
    const capped = await appShotAccessibleElements(
      element({
        value: "A".repeat(APP_SHOT_MAX_TEXT - 1) + " ".repeat(10) + "LOST",
      }),
      "win32",
      undefined,
    );
    assert.equal(capped?.truncated, true);
    assert.ok(parseAppShotAccessibility(capped));
    const tree = rich(
      await appShotAccessibleElements(
        element({ name: "\ud800 leading" }),
        "win32",
        imageSize,
      ),
    );
    assert.equal(tree.root.name, "leading");
    assert.ok(parseAppShotAccessibility(tree, imageSize));
  });

  it("fences a late children result before reading any returned child", async () => {
    let expired = false;
    let accessed = false;
    const late = element();
    Object.defineProperty(late, "name", {
      get() {
        accessed = true;
        return "Must not read";
      },
    });
    const result = await appShotAccessibleElements(
      element({
        children: async () => {
          expired = true;
          return [late];
        },
      }),
      "win32",
      imageSize,
      () => expired,
    );
    assert.equal(result, undefined);
    assert.equal(accessed, false);
  });
});

describe("total parent validation of accessibility worker data", () => {
  it("accepts only bounded complete rich/flat payloads", () => {
    const value = payload(
      leaf({
        name: "Synthetic",
        children: [leaf({ role: "button", actions: ["press"] })],
      }),
    );
    const read = parseAppShotAccessibility(value, imageSize)!;
    assert.equal(read.format, "element-tree");
    assert.deepEqual(JSON.parse(read.text), value);
    assert.equal(parseAppShotAccessibility(value), undefined);
    assert.deepEqual(
      parseAppShotAccessibility({
        format: "flat-text",
        text: "Text",
        truncated: false,
      }),
      { format: "flat-text", text: "Text", truncated: false },
    );
  });

  it("rejects control/native fields, unknown states, fabricated geometry and invalid strings", () => {
    const base = payload();
    const variants: unknown[] = [
      { ...base, target: "PRIVATE" },
      { ...base, imageSize: { width: 1, height: 1 } },
      { ...base, coordinateSpace: "screen" },
      { ...base, truncated: "false" },
      { ...base, root: { ...base.root, raw: {} } },
      { ...base, root: { ...base.root, pid: 471 } },
      { ...base, root: { ...base.root, selector: "button" } },
      {
        ...base,
        root: { ...base.root, bounds: { ...base.root.bounds, x: 10 } },
      },
      {
        ...base,
        root: {
          ...base.root,
          children: [leaf({ bounds: { x: 0, y: 0, width: 1, height: 1 } })],
        },
      },
      { ...base, root: { ...base.root, state: { active: false } } },
      { ...base, root: { ...base.root, state: { visible: true } } },
      { ...base, root: { ...base.root, state: { checked: true } } },
      { ...base, root: { ...base.root, state: { selectedText: "PRIVATE" } } },
      { ...base, root: { ...base.root, actions: ["press", "press"] } },
      {
        ...base,
        root: { ...base.root, actions: [{ name: "press", target: 42 }] },
      },
      { ...base, root: { ...base.root, name: "x".repeat(1001) } },
      { ...base, root: { ...base.root, description: "x".repeat(2001) } },
      { ...base, root: { ...base.root, value: "x\0y" } },
      { ...base, root: { ...base.root, value: "\ud800" } },
      { ...base, root: { ...base.root, name: " untrimmed " } },
      { format: "flat-text", text: "Text", truncated: false, handle: 42 },
      {
        format: "flat-text",
        text: "x".repeat(APP_SHOT_MAX_TEXT + 1),
        truncated: true,
      },
      { format: "flat-text", text: "text\0", truncated: false },
    ];
    const stateHook = Object.create({ toJSON: () => ({ raw: "PRIVATE" }) });
    variants.push({ ...base, root: { ...base.root, state: stateHook } });
    const actionHook = Object.assign(["press"], { toJSON: () => ["PRIVATE"] });
    variants.push({ ...base, root: { ...base.root, actions: actionHook } });
    for (const value of variants)
      assert.equal(parseAppShotAccessibility(value, imageSize), undefined);
  });

  it("rejects cyclic, overly deep/wide and serialized-budget payloads without recursive overflow", () => {
    const cycle = payload();
    cycle.root.children.push(cycle.root);
    assert.equal(parseAppShotAccessibility(cycle, imageSize), undefined);
    const deep = payload();
    let current = deep.root;
    for (let i = 0; i < 20000; i++) {
      const next = leaf();
      current.children.push(next);
      current = next;
    }
    assert.equal(parseAppShotAccessibility(deep, imageSize), undefined);
    const wide = payload(
      leaf({
        children: Array.from({ length: APP_SHOT_MAX_NODES }, () => leaf()),
      }),
    );
    assert.equal(parseAppShotAccessibility(wide, imageSize), undefined);
    const serialized = payload(
      leaf({ children: Array.from({ length: 300 }, () => leaf()) }),
    );
    assert.equal(serializeAppShotTree(serialized), undefined);
    assert.equal(parseAppShotAccessibility(serialized, imageSize), undefined);
    const throws = {
      get format() {
        throw new Error("Unsafe getter");
      },
      truncated: false,
    };
    assert.equal(parseAppShotAccessibility(throws, imageSize), undefined);
  });

  it("validates actual worker results after exit and rejects late semantic data after timeout/cancel", async () => {
    for (const action of ["success", "unsafe", "timeout", "cancel"] as const) {
      let message = (_value: unknown) => {};
      let exit = () => {};
      const signals: string[] = [];
      const requests: unknown[] = [];
      const child: AppShotNativeChild = {
        onMessage: (listener) => {
          message = listener;
        },
        onExit: (listener) => {
          exit = listener;
        },
        send: (request, callback) => {
          requests.push(request);
          callback();
        },
        kill: (signal = "SIGTERM") => {
          signals.push(signal);
          exit();
        },
      };
      const abort = new AbortController();
      const pending = readCapturedAppShotAccessibility(identity, {
        fork: () => child,
        signal: abort.signal,
        timeoutMs: 5,
        imageSize,
      });
      message("ready");
      assert.deepEqual(requests, [{ identity, imageSize }]);
      if (action === "cancel") abort.abort();
      else if (action !== "timeout")
        message({
          type: "result",
          value: {
            ...payload(),
            ...(action === "unsafe" ? { handle: 42 } : {}),
          },
        });
      const result = await pending;
      message({ type: "result", value: payload() });
      assert.equal(
        result?.format,
        action === "success" ? "element-tree" : undefined,
      );
      assert.deepEqual(signals, ["SIGTERM"]);
    }
  });
});

describe("semantic data in existing App Shot context", () => {
  it("passes actual selected PNG dimensions and keeps complete semantic JSON instead of clipping it", async () => {
    const data = payload();
    data.imageSize = { width: 1, height: 1 };
    data.root.bounds = { x: 0, y: 0, ...data.imageSize };
    const read = parseAppShotAccessibility(data, data.imageSize)!;
    for (const oversized of [false, true]) {
      const service = createAppShotService({
        getWindowSources: async () => [
          {
            id: "window:42:0",
            title: identity.windowTitle,
            image: { isEmpty: () => false, toPNG: () => png },
          },
        ],
        readAccessibility: async (request) => {
          assert.deepEqual(request.imageSize, { width: 1, height: 1 });
          return {
            ...identity,
            ...read,
            text: oversized ? "x".repeat(APP_SHOT_MAX_TEXT + 1) : read.text,
          };
        },
      });
      const [source] = await service.listSources();
      const capture = await service.capture(source!.id, {
        includeAccessibility: true,
      });
      if (oversized) assert.match(capture.context, /Screenshot only/);
      else {
        assert.match(capture.context, /Accessibility semantic tree/);
        assert.ok(capture.context.includes(read.text));
        assert.match(capture.context, /not permission to control/);
      }
    }
  });

  it("restamps Windows root geometry to the final resized image, preserving null child bounds", () => {
    const read = parseAppShotAccessibility(
      payload(leaf({ children: [leaf({ role: "button" })] })),
      imageSize,
    )!;
    const shot = windowsAppShotDraft(
      {
        png,
        width: 1,
        height: 1,
        identity: { ...identity, platform: "win32" },
        region: identity.bounds,
        captureKind: "screen-region",
        accessibility: read,
      },
      true,
    );
    const line = shot.context
      .split("\n")
      .find((line) => line.startsWith("Accessibility semantic tree"))!;
    const actual = JSON.parse(line.slice(line.indexOf(": ") + 2));
    assert.deepEqual(actual.imageSize, { width: 1, height: 1 });
    assert.deepEqual(actual.root.bounds, { x: 0, y: 0, width: 1, height: 1 });
    assert.equal(actual.root.children[0].bounds, null);
    assert.ok(parseAppShotAccessibility(actual, { width: 1, height: 1 }));
  });

  it("labels semantic context across Linux draft paths without changing the attachment/control boundary", () => {
    const read = parseAppShotAccessibility(payload(), imageSize)!;
    const window = {
      id: 1,
      pid: 471,
      processId: 471,
      appIdentifier: "synthetic",
      appId: "synthetic",
      accessibilityBoundsReliable: false as const,
      title: "Synthetic",
      appName: "Editor",
      bounds: { x: 0, y: 0, ...imageSize },
    };
    const base = { png, ...imageSize, window };
    const captures = [
      niriAppShotDraft(base, true, read),
      gnomeAppShotDraft(base, true, read),
      nativeWaylandAppShotDraft(
        "KDE",
        {
          ...base,
          window: { ...window, id: "uuid", clientBounds: window.bounds },
        },
        true,
        read,
      ),
    ];
    for (const capture of captures) {
      assert.match(capture.context, /Accessibility semantic tree/);
      assert.ok(capture.context.includes(read.text));
      assert.match(capture.context, /not permission to control/);
      assert.equal(capture.bytes, png);
    }
  });
});

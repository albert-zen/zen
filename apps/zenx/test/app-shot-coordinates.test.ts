import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readAppShotAccessibilityWithApi,
  type AppShotAccessibilityElement,
} from "../src/main/app-shot-accessibility.js";
import {
  parseAppShotAccessibility,
  resizeAppShotAccessibility,
  APP_SHOT_MAX_TEXT,
  type AppShotAccessibilityIdentity,
  type AppShotAccessibilityPayload,
  type AppShotBounds,
  type AppShotImageSize,
} from "../src/main/app-shot-native-contract.js";
import {
  windowsAppShotDraft,
  createAppShotService,
} from "../src/main/app-shot.js";

const source = { x: -100, y: 50, width: 800, height: 600 };
const imageSize = { width: 1600, height: 1200 };
const identity = {
  platform: "darwin" as const,
  pid: 471,
  windowId: 42,
  windowTitle: "Synthetic coordinates",
  bounds: source,
};
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
function rich(value: AppShotAccessibilityPayload | undefined) {
  assert.ok(value?.format === "element-tree");
  return value;
}
async function read(
  children: AppShotAccessibilityElement[],
  size: AppShotImageSize = imageSize,
  selected: AppShotAccessibilityIdentity = identity,
) {
  const root = element({
    name: selected.windowTitle,
    bounds: selected.bounds,
    children: async () => children,
  });
  const app = {
    pid: selected.pid,
    asElement: () => root,
    children: async () => [root],
  };
  return rich(
    await readAppShotAccessibilityWithApi(
      { byPid: async () => app, foreground: async () => app },
      selected,
      undefined,
      size,
    ),
  );
}
function contextTree(context: string) {
  const line = context
    .split("\n")
    .find((line) => line.startsWith("Accessibility semantic tree"))!;
  assert.ok(line);
  return JSON.parse(line.slice(line.indexOf(": ") + 2)) as Extract<
    AppShotAccessibilityPayload,
    { format: "element-tree" }
  >;
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n8kAAAAASUVORK5CYII=",
  "base64",
);

describe("conditional captured-image accessibility coordinates", () => {
  it("maps an 800x600 matched logical root to actual 1600x1200 pixels", async () => {
    const result = await read([
      element({
        name: "Button",
        bounds: { x: 0, y: 100, width: 80, height: 40 },
      }),
    ]);
    assert.deepEqual(result.root.bounds, { x: 0, y: 0, ...imageSize });
    assert.deepEqual(result.root.children[0]!.bounds, {
      x: 200,
      y: 100,
      width: 160,
      height: 80,
    });
    assert.ok(parseAppShotAccessibility(result, imageSize));
  });

  it("rounds edges at fractional scales, clips against the image rather than parent", async () => {
    const result = await read(
      [
        element({
          bounds: { x: -101, y: 49, width: 802, height: 602 },
          children: async () => [
            element({ bounds: { x: -99, y: 51, width: 1, height: 1 } }),
          ],
        }),
        element({
          bounds: { x: -90, y: 60, width: 5, height: 5 },
          children: async () => [
            element({ bounds: { x: 600, y: 550, width: 200, height: 200 } }),
          ],
        }),
      ],
      { width: 1001, height: 751 },
    );
    assert.deepEqual(result.root.children[0]!.bounds, {
      x: 0,
      y: 0,
      width: 1001,
      height: 751,
    });
    assert.deepEqual(result.root.children[0]!.children[0]!.bounds, {
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    });
    assert.deepEqual(result.root.children[1]!.children[0]!.bounds, {
      x: 876,
      y: 626,
      width: 125,
      height: 125,
    });
  });

  it("retains semantics when geometry is outside, missing, unsafe, sentinel or throws", async () => {
    const values: unknown[] = [
      null,
      { x: -100, y: 50, width: 0, height: 2 },
      { x: -101, y: 50, width: 1, height: 1 },
      { x: 700, y: 650, width: 10, height: 10 },
      { x: 0, y: 0, width: -1, height: 1 },
      { x: NaN, y: 50, width: 1, height: 1 },
      { x: -100, y: Infinity, width: 1, height: 1 },
      { x: -2147483648, y: -2147483648, width: 800, height: 600 },
      { width: 1, height: 1 },
    ];
    const children = values.map((bounds, i) =>
      element({ name: `Text ${i}`, bounds: bounds as AppShotBounds }),
    );
    const throwing = element({ name: "Still readable" });
    Object.defineProperty(throwing, "bounds", {
      get() {
        throw new Error("Private geometry failure");
      },
    });
    children.push(throwing);
    const result = await read(children);
    assert.equal(result.root.children.length, children.length);
    assert.ok(result.root.children.every((child) => child.bounds === null));
    assert.equal(result.root.children.at(-1)!.name, "Still readable");
  });

  it("parent admits only exact safe-integer positive image rectangles", async () => {
    const result = await read([element({ bounds: source })]);
    assert.ok(parseAppShotAccessibility(result, imageSize));
    const invalid = [
      { x: -1, y: 0, width: 1, height: 1 },
      { x: 0.5, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 1.5, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 1599, y: 0, width: 2, height: 1 },
      { x: 0, y: 1199, width: 1, height: 2 },
      { x: 0, y: 0, width: 1, height: 1, handle: 42 },
      { x: 0, y: NaN, width: 1, height: 1 },
      { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER + 1, height: 1 },
    ];
    for (const bounds of invalid) {
      result.root.children[0]!.bounds = bounds;
      assert.equal(parseAppShotAccessibility(result, imageSize), undefined);
    }
  });

  it("uses actual resized macOS PNG dimensions without assuming Retina scale", async () => {
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
        const payload = await read(
          [element({ bounds: source })],
          request.imageSize,
        );
        return {
          ...identity,
          ...parseAppShotAccessibility(payload, request.imageSize)!,
        };
      },
    });
    const [selected] = await service.listSources();
    const capture = await service.capture(selected!.id, {
      includeAccessibility: true,
    });
    assert.deepEqual(contextTree(capture.context).root.children[0]!.bounds, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("rescales every Windows descendant after initial logical-to-pixel mapping, preserving null and rounding collapse", async () => {
    const result = await read(
      [
        element({
          bounds: { x: -99, y: 51, width: 3, height: 3 },
          children: async () => [
            element({ bounds: { x: -99, y: 51, width: 1, height: 1 } }),
            element(),
            element({ bounds: source }),
          ],
        }),
      ],
      { width: 1001, height: 751 },
      { ...identity, platform: "win32" },
    );
    const shot = windowsAppShotDraft(
      {
        png,
        width: 400,
        height: 300,
        identity: { ...identity, platform: "win32" },
        region: source,
        captureKind: "screen-region",
        accessibility: parseAppShotAccessibility(result, result.imageSize),
      },
      true,
    );
    const actual = contextTree(shot.context);
    assert.deepEqual(actual.root.bounds, {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    assert.deepEqual(actual.root.children[0]!.bounds, {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    assert.deepEqual(actual.root.children[0]!.children[0]!.bounds, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    assert.equal(actual.root.children[0]!.children[1]!.bounds, null);
    assert.deepEqual(
      actual.root.children[0]!.children[2]!.bounds,
      actual.root.bounds,
    );
    const tiny = windowsAppShotDraft(
      {
        png,
        width: 1,
        height: 1,
        identity: { ...identity, platform: "win32" },
        region: source,
        captureKind: "screen-region",
        accessibility: parseAppShotAccessibility(result, result.imageSize),
      },
      true,
    );
    assert.equal(contextTree(tiny.context).root.children[0]!.bounds, null);
    assert.ok(parseAppShotAccessibility(actual, { width: 400, height: 300 }));
  });
  it("revalidates Windows context before resize and rejects serialization growth past the output budget", async () => {
    const payload = await read([element({ bounds: source })], {
      width: 1,
      height: 1,
    });
    const valid = parseAppShotAccessibility(payload, payload.imageSize)!;
    payload.root.children[0]!.bounds = { x: -1, y: 0, width: 1, height: 1 };
    assert.equal(
      resizeAppShotAccessibility(
        { ...valid, text: JSON.stringify(payload) },
        imageSize,
      ),
      undefined,
    );
    payload.root.children = [];
    const child = { ...payload.root, name: "Synthetic", children: [] };
    while (
      JSON.stringify(payload).length + JSON.stringify(child).length + 1 <
      APP_SHOT_MAX_TEXT
    )
      payload.root.children.push({ ...child });
    const remaining = APP_SHOT_MAX_TEXT - JSON.stringify(payload).length + 2;
    payload.root.description = "x".repeat(remaining);
    const exact = parseAppShotAccessibility(payload, payload.imageSize)!;
    assert.ok(exact);
    assert.equal(exact.text.length, APP_SHOT_MAX_TEXT);
    assert.equal(
      resizeAppShotAccessibility(exact, { width: 8192, height: 8192 }),
      undefined,
    );
    assert.equal(
      exact.text.length,
      APP_SHOT_MAX_TEXT,
      "Do not mutate original review data",
    );
  });
});

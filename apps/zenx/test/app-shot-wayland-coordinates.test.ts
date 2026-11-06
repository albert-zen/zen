import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readAppShotAccessibilityWithApi,
  type AppShotAccessibilityElement,
} from "../src/main/app-shot-accessibility.js";
import {
  parseAppShotAccessibility,
  type AppShotAccessibilityBounds,
  type AppShotLinuxCaptureIdentity,
} from "../src/main/app-shot-native-contract.js";
import {
  gnomeAppShotIdentity,
  nativeWaylandAppShotIdentity,
  niriAppShotIdentity,
} from "../src/main/app-shot.js";

const frame = { x: 100, y: 200, width: 800, height: 600 };
const client = { x: 100, y: 229, width: 800, height: 571 };
const image = { width: 1600, height: 1200 };
const identity: AppShotLinuxCaptureIdentity = {
  platform: "linux",
  matchMode: "wayland",
  pid: 471,
  windowTitle: "Synthetic Wayland",
  bounds: frame,
};
function element(
  bounds: AppShotAccessibilityBounds | null,
  children: AppShotAccessibilityElement[] = [],
): AppShotAccessibilityElement {
  return {
    role: "button",
    name: "Synthetic child",
    bounds,
    children: async () => children,
  };
}
async function read(
  selected = identity,
  rootBounds: AppShotAccessibilityBounds = frame,
  children = [element({ x: 120, y: 230, width: 100, height: 50 })],
  freshBounds = rootBounds,
) {
  const window = {
    ...element(rootBounds, children),
    name: selected.windowTitle,
    pid: selected.pid,
    raw: { bus_name: ":1.471", object_path: "/window/42" },
  };
  let metadataReads = 0;
  let treeReads = 0;
  const app = {
    pid: selected.pid,
    asElement: () => window,
    children: async () => {
      metadataReads++;
      return [
        {
          ...window,
          bounds: metadataReads === 1 ? rootBounds : freshBounds,
          children: async () => {
            treeReads++;
            return children;
          },
        },
      ];
    },
  };
  const result = await readAppShotAccessibilityWithApi(
    {
      byPid: async () => app,
      foreground: async () => {
        throw new Error("No foreground read");
      },
      list: async () => {
        throw new Error("No enumeration");
      },
    },
    selected,
    undefined,
    image,
  );
  assert.ok(result?.format === "element-tree");
  assert.equal(
    metadataReads,
    2,
    "Reuse existing pre/post top-level reads only",
  );
  assert.equal(treeReads, 1, "One same-window traversal only");
  assert.ok(parseAppShotAccessibility(result, image));
  assert.doesNotMatch(
    JSON.stringify(result),
    /bus_name|object_path|windowId|processId|:1\.471/,
  );
  return result;
}

describe("T3 Wayland coordinate reliability", () => {
  it("requires trusted origin agreement and valid descendant variation together", async () => {
    const result = await read();
    assert.deepEqual(result.root.children[0]!.bounds, {
      x: 40,
      y: 60,
      width: 200,
      height: 100,
    });
    for (const bounds of [
      { width: 800, height: 600 },
      { ...frame, x: 103 },
      { ...frame, y: 203 },
    ]) {
      const unmatched = await read({ ...identity, bounds });
      assert.equal(unmatched.root.children[0]!.bounds, null);
      assert.equal(unmatched.root.children[0]!.name, "Synthetic child");
    }
    for (const bounds of [
      { width: 800, height: 600 },
      { ...frame, x: -2147483648, y: -2147483648 },
    ]) {
      assert.equal(
        (await read(identity, bounds)).root.children[0]!.bounds,
        null,
      );
    }
    const close = await read(identity, { ...frame, x: 102, y: 198 });
    assert.deepEqual(close.root.children[0]!.bounds, {
      x: 36,
      y: 64,
      width: 200,
      height: 100,
    });
  });

  it("keeps all descendants null for zero/exactly-two variation; more than two unlocks valid geometry", async () => {
    for (const delta of [0, 2, 2.01, -2, -2.01]) {
      const result = await read(identity, frame, [
        element({ ...frame, width: 20, height: 20 }),
        element({ ...frame, x: frame.x + delta, width: 10, height: 10 }),
      ]);
      assert.equal(
        result.root.children.every((child) => child.bounds === null),
        Math.abs(delta) <= 2,
      );
    }
    const variedY = await read(identity, frame, [
      element({ ...frame, y: frame.y + 3, width: 10, height: 10 }),
    ]);
    assert.deepEqual(variedY.root.children[0]!.bounds, {
      x: 0,
      y: 6,
      width: 20,
      height: 20,
    });
  });

  it("invalid/sentinel/throwing or known secure geometry cannot establish variation", async () => {
    for (const bad of [
      { ...frame, x: NaN },
      { ...frame, x: Infinity },
      { ...frame, x: -2147483648 },
      { ...frame, x: 200, width: 0 },
      { width: 10, height: 10 },
      null,
    ]) {
      const result = await read(identity, frame, [
        element({ ...frame, width: 10, height: 10 }),
        element(bad),
      ]);
      assert.ok(result.root.children.every((child) => child.bounds === null));
    }
    const throwing = element(frame);
    Object.defineProperty(throwing, "bounds", {
      get() {
        throw new Error("Unavailable");
      },
    });
    assert.ok(
      (
        await read(identity, frame, [element(frame), throwing])
      ).root.children.every((child) => child.bounds === null),
    );
    const secure = {
      ...element({ ...frame, x: frame.x + 10 }),
      raw: { atspi_role: "password text" },
    };
    const omitted = await read(identity, frame, [element(frame), secure]);
    assert.equal(omitted.root.children.length, 1);
    assert.equal(omitted.root.children[0]!.bounds, null);
  });

  it("maps decorated client geometry against the frame but measures variation against actual AX root", async () => {
    const selected = { ...identity, clientBounds: client };
    const child = { x: 120, y: 259, width: 100, height: 50 };
    const result = await read(selected, client, [element(child)]);
    assert.deepEqual(result.root.children[0]!.bounds, {
      x: 40,
      y: 118,
      width: 200,
      height: 100,
    });
    const titleOnly = await read(selected, client, [
      element({ ...client, width: 100, height: 50 }),
    ]);
    assert.equal(titleOnly.root.children[0]!.bounds, null);
    // Client dimensions win when both are within tolerance; a frame-origin fallback would be wrong.
    const nearFrameClient = { ...frame, y: 201, height: 599 };
    const preferred = await read(
      { ...identity, clientBounds: nearFrameClient },
      { ...frame, y: 203 },
      [element(child)],
    );
    assert.deepEqual(preferred.root.children[0]!.bounds, {
      x: 40,
      y: 118,
      width: 200,
      height: 100,
    });
    const missingClientOrigin = await read(
      { ...identity, clientBounds: { width: 800, height: 571 } },
      client,
      [element(child)],
    );
    assert.equal(missingClientOrigin.root.children[0]!.bounds, null);
  });

  it("fresh origin drift strips every descendant without discarding valid semantic context", async () => {
    const result = await read(
      identity,
      frame,
      [
        element({ x: 120, y: 230, width: 100, height: 50 }, [
          element({ x: 130, y: 240, width: 10, height: 10 }),
        ]),
      ],
      { ...frame, x: frame.x + 3 },
    );
    assert.deepEqual(result.root.bounds, { x: 0, y: 0, ...image });
    assert.equal(result.root.children[0]!.bounds, null);
    assert.equal(result.root.children[0]!.children[0]!.bounds, null);
    assert.equal(result.root.children[0]!.children[0]!.name, "Synthetic child");
  });

  it("retains observed GNOME/KDE/Hyprland origins privately and never promotes Niri placeholders", async () => {
    const shot = {
      png: Buffer.from([1]),
      ...image,
      window: {
        title: identity.windowTitle,
        appName: "Synthetic",
        appIdentifier: "synthetic",
        processId: identity.pid,
        bounds: frame,
        accessibilityBoundsReliable: true,
      },
    };
    const gnome = gnomeAppShotIdentity(shot)!;
    assert.deepEqual(gnome.bounds, frame);
    assert.deepEqual((await read(gnome)).root.children[0]!.bounds, {
      x: 40,
      y: 60,
      width: 200,
      height: 100,
    });
    const unreliable = gnomeAppShotIdentity({
      ...shot,
      window: { ...shot.window, accessibilityBoundsReliable: false },
    })!;
    assert.equal(unreliable.bounds.x, undefined);
    assert.equal((await read(unreliable)).root.children[0]!.bounds, null);
    for (const clientBounds of [client, frame]) {
      const native = nativeWaylandAppShotIdentity({
        ...shot,
        window: { ...shot.window, id: "private-uuid", clientBounds },
      })!;
      assert.deepEqual(native.bounds, frame);
      assert.deepEqual(native.clientBounds, clientBounds);
      assert.equal(native.windowId, undefined);
      assert.ok((await read(native, clientBounds)).root.children[0]!.bounds);
    }
    const niri = niriAppShotIdentity({
      ...shot,
      window: {
        id: 42,
        pid: identity.pid,
        title: identity.windowTitle,
        appId: "synthetic",
        bounds: { ...frame, x: 0, y: 0 },
        accessibilityBoundsReliable: false,
      },
    })!;
    assert.deepEqual(niri.bounds, { width: 800, height: 600 });
    assert.equal((await read(niri)).root.children[0]!.bounds, null);
  });
});

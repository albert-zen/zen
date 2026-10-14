import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  WorkspaceBrowserRenderer,
  captureWorkspacePage,
} from "../src/main/workspace-browser-renderer.js";

class View {
  parent?: Window;
  visible = true;
  bounds = { x: 20, y: 30, width: 640, height: 480 };
  destroyed = false;
  autoFrame = true;
  frame?: (image: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
  }) => void;
  redraw = async () => ({});
  debuggerAttachments = 0;
  debuggerAttached = true;
  subscriptions = 0;
  unsubscriptions = 0;
  webContents = {
    isDestroyed: () => this.destroyed,
    capturePage: async () => ({}),
    debugger: {
      isAttached: () => this.debuggerAttached,
      attach: (version: string) => {
        assert.equal(version, "1.3");
        this.debuggerAttached = true;
        this.debuggerAttachments++;
      },
      sendCommand: async (method: string, options: unknown) => {
        assert.equal(method, "Page.captureScreenshot");
        assert.deepEqual(options, {
          format: "jpeg",
          quality: 0,
          fromSurface: true,
          captureBeyondViewport: false,
        });
        return await this.redraw();
      },
    },
    beginFrameSubscription: (
      _dirty: boolean,
      callback: NonNullable<View["frame"]>,
    ) => {
      this.subscriptions++;
      this.frame = callback;
    },
    endFrameSubscription: () => {
      this.unsubscriptions++;
      this.frame = undefined;
    },
  };
  setVisible(value: boolean) {
    this.visible = value;
  }
  getVisible() {
    return this.visible;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = { ...value };
  }
  getBounds() {
    return { ...this.bounds };
  }
}
class Window extends EventEmitter {
  visible = false;
  minimized = false;
  destroyed = false;
  inactiveShows = 0;
  children: View[] = [];
  contentView = {
    children: this.children,
    addChildView: (view: View) => {
      view.parent?.contentView.removeChildView(view);
      this.children.push(view);
      view.parent = this;
    },
    removeChildView: (view: View) => {
      const index = this.children.indexOf(view);
      if (index >= 0) this.children.splice(index, 1);
      if (view.parent === this) view.parent = undefined;
    },
  };
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isDestroyed() {
    return this.destroyed;
  }
  setIgnoreMouseEvents(value: boolean) {
    assert.equal(value, true);
  }
  showInactive() {
    this.inactiveShows++;
    this.visible = true;
    for (const view of this.children) {
      const callback = view.frame;
      if (view.autoFrame)
        setTimeout(
          () =>
            callback?.({
              isEmpty: () => false,
              getSize: () => ({
                width: view.bounds.width,
                height: view.bounds.height,
              }),
            }),
          10,
        );
    }
  }
  destroy() {
    assert.equal(this.children.length, 0, "never destroy the shared view");
    this.destroyed = true;
    this.emit("closed");
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function tick() {
  await new Promise((r) => setImmediate(r));
}
function fixture(timeoutMs = 5_000) {
  const owner = new Window(),
    view = new View();
  owner.contentView.addChildView(view);
  let current = true,
    invalidations = 0;
  const windows: Window[] = [];
  let scale = 1;
  const renderer = new WorkspaceBrowserRenderer(
    (options) => {
      assert.deepEqual(options, {
        width: 640,
        height: 480,
        x: -10000,
        y: -10000,
        show: false,
        focusable: false,
        skipTaskbar: true,
        opacity: 0,
      });
      const window = new Window();
      windows.push(window);
      return window as never;
    },
    () => scale,
    timeoutMs,
  );
  const mount = {
    window: owner as never,
    isCurrent: () => current,
    invalidate: () => {
      invalidations++;
      current = false;
    },
  };
  return {
    owner,
    view,
    renderer,
    windows,
    mount,
    setScale: (value: number) => {
      scale = value;
    },
    current: () => current,
    invalidations: () => invalidations,
    replace: () => {
      current = false;
    },
    render: <T>(operation: () => Promise<T>) =>
      renderer.render(view as never, () => mount, operation),
  };
}

test("renderer waits for a real frame beyond the old 100ms settle window", async () => {
  const f = fixture();
  f.view.autoFrame = false;
  let operations = 0;
  const pending = f.render(async () => {
    operations++;
  });
  const settled = pending.catch(() => undefined);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(operations, 0, "elapsed time is not a compositor frame");
    assert.equal(f.view.subscriptions, 1);
    f.view.frame!({
      isEmpty: () => false,
      getSize: () => ({ width: 640, height: 480 }),
    });
    await pending;
    assert.equal(operations, 1);
    assert.equal(f.view.unsubscriptions, 1);
  } finally {
    f.renderer.close();
    await settled;
  }
});
for (const mode of ["hidden", "minimized"] as const)
  test(`${mode} mount borrows a compositor and restores exact bounds without showing its owner`, async () => {
    const f = fixture();
    if (mode === "minimized") {
      f.owner.visible = true;
      f.owner.minimized = true;
    }
    const original = f.view.getBounds();
    const result = {};
    assert.equal(
      await f.render(async () => {
        assert.equal(f.view.parent, f.windows[0]);
        assert.deepEqual(f.view.getBounds(), {
          x: 0,
          y: 0,
          width: 640,
          height: 480,
        });
        return result;
      }),
      result,
    );
    assert.equal(f.view.parent, f.owner);
    assert.deepEqual(f.view.bounds, original);
    assert.equal(f.owner.visible, mode === "minimized");
    assert.equal(f.owner.minimized, mode === "minimized");
    assert.equal(f.owner.inactiveShows, 0);
    assert.equal(f.windows[0]!.inactiveShows, 1);
    assert.equal(f.windows[0]!.destroyed, true);
    assert.equal(f.invalidations(), 0);
  });
test("visible mount uses its own compositor", async () => {
  const f = fixture();
  f.owner.visible = true;
  await f.render(async () => {
    assert.equal(f.view.parent, f.owner);
  });
  assert.equal(f.windows.length, 0);
});
for (const event of ["show", "restore", "hide", "minimize"] as const) {
  test(`${event} during compositor wait returns the view immediately and prevents dispatch`, async () => {
    const f = fixture();
    let calls = 0;
    const result = f.render(async () => {
      calls++;
    });
    await tick();
    f.owner.emit(event);
    assert.equal(f.view.parent, f.owner);
    assert.equal(f.invalidations(), 1);
    await assert.rejects(result, /view changed/);
    assert.equal(calls, 0);
    assert.equal(f.windows[0]!.destroyed, true);
  });
  test(`${event} during pending capture returns immediately and rejects the late result`, async () => {
    const f = fixture(),
      entered = deferred(),
      finish = deferred();
    const result = f.render(async () => {
      entered.resolve();
      await finish.promise;
      return "late";
    });
    await entered.promise;
    f.owner.emit(event);
    assert.equal(f.view.parent, f.owner);
    assert.equal(f.windows[0]!.destroyed, true);
    finish.resolve();
    await assert.rejects(result, /view changed/);
    assert.equal(f.invalidations(), 1);
  });
}
for (const change of ["new-owner", "hide", "close"] as const)
  test(`${change} supersedes the old lease without late restoration`, async () => {
    const f = fixture(),
      entered = deferred(),
      finish = deferred();
    const result = f.render(async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    f.replace();
    f.renderer.release(f.view as never);
    const successor = new Window();
    if (change === "new-owner") {
      successor.contentView.addChildView(f.view);
      f.view.setBounds({ x: 5, y: 6, width: 300, height: 200 });
    }
    if (change === "close") f.view.destroyed = true;
    finish.resolve();
    await assert.rejects(result, /view changed/);
    assert.equal(f.view.parent, change === "new-owner" ? successor : undefined);
    assert.equal(f.owner.children.length, 0);
    assert.equal(
      f.invalidations(),
      0,
      "old lease must not invalidate successor",
    );
    if (change === "new-owner")
      assert.deepEqual(f.view.bounds, { x: 5, y: 6, width: 300, height: 200 });
  });
test("physical successor ownership is not overwritten even if an external move did not update the logical witness", async () => {
  const f = fixture(),
    entered = deferred(),
    finish = deferred();
  const result = f.render(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const successor = new Window();
  successor.contentView.addChildView(f.view);
  finish.resolve();
  await assert.rejects(result, /view changed/);
  assert.equal(f.view.parent, successor);
  assert.equal(f.owner.children.length, 0);
  assert.equal(f.windows[0]!.destroyed, true);
});
test("capture error restores old owner and preserves original error", async () => {
  const f = fixture(),
    error = new Error("UnknownVizError");
  await assert.rejects(
    f.render(async () => {
      throw error;
    }),
    (e) => e === error,
  );
  assert.equal(f.view.parent, f.owner);
  assert.equal(f.windows[0]!.destroyed, true);
});
test("restore failure remains a failure and destroys only the now-empty temporary window", async () => {
  const f = fixture();
  const error = new Error("owner attach failed");
  await assert.rejects(
    f.render(async () => {
      f.owner.contentView.addChildView = () => {
        throw error;
      };
    }),
    (e) => e === error,
  );
  assert.equal(f.windows[0]!.destroyed, true);
  assert.equal(f.view.destroyed, false);
});
test("closed owner is never restored and pending operation cannot publish", async () => {
  const f = fixture(),
    entered = deferred(),
    finish = deferred();
  const result = f.render(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  f.owner.destroyed = true;
  f.owner.emit("closed");
  assert.equal(f.view.parent, undefined);
  finish.resolve();
  await assert.rejects(result, /view changed/);
});
test("native capture deadline invalidates once; late reply cannot become success", async () => {
  const view = new View(),
    finish = deferred();
  let invalidated = 0,
    captures = 0;
  view.webContents.capturePage = async () => {
    captures++;
    await finish.promise;
    return {};
  };
  await assert.rejects(
    captureWorkspacePage(view as never, () => invalidated++, 5),
    /capture timed out/,
  );
  finish.resolve();
  await tick();
  assert.equal(invalidated, 1);
  assert.equal(captures, 1);
});
test("native capture success and original error are preserved without deadline side effects", async () => {
  const view = new View();
  let invalidated = 0;
  const image = {};
  view.webContents.capturePage = async () => image;
  assert.equal(
    await captureWorkspacePage(view as never, () => invalidated++, 5),
    image,
  );
  const error = new Error("native error");
  view.webContents.capturePage = async () => {
    throw error;
  };
  await assert.rejects(
    captureWorkspacePage(view as never, () => invalidated++, 5),
    (e) => e === error,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(invalidated, 0);
});

test("native owner events cannot throw through Electron when restoration fails", async () => {
  const f = fixture(),
    entered = deferred(),
    finish = deferred();
  const result = f.render(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const error = new Error("native restore failed");
  f.owner.contentView.addChildView = () => {
    throw error;
  };
  assert.doesNotThrow(() => f.owner.emit("show"));
  finish.resolve();
  await assert.rejects(result, (value) => value === error);
  assert.equal(f.windows[0]!.destroyed, true);
});

test("simultaneous operation and restoration failures retain both causes", async () => {
  const f = fixture(),
    operation = new Error("native capture failed"),
    cleanup = new Error("restore failed");
  await assert.rejects(
    f.render(async () => {
      f.owner.contentView.addChildView = () => {
        throw cleanup;
      };
      throw operation;
    }),
    (value) =>
      value instanceof AggregateError &&
      value.errors[0] === operation &&
      value.errors[1] === cleanup,
  );
});

test("capture deadline still restores the unchanged hidden mount", async () => {
  const f = fixture(),
    finish = deferred();
  let invalidations = 0;
  f.view.webContents.capturePage = async () => {
    await finish.promise;
    return {};
  };
  await assert.rejects(
    f.render(
      async () =>
        await captureWorkspacePage(
          f.view as never,
          () => {
            invalidations++;
          },
          5,
        ),
    ),
    /capture timed out/,
  );
  assert.equal(invalidations, 1);
  assert.equal(f.view.parent, f.owner);
  assert.equal(f.windows[0]!.destroyed, true);
  finish.resolve();
});

test("temporary attachment failure restores the unchanged owner without invoking the operation", async () => {
  const owner = new Window(),
    view = new View();
  owner.contentView.addChildView(view);
  const temporary = new Window(),
    error = new Error("cannot attach compositor");
  temporary.contentView.addChildView = () => {
    throw error;
  };
  const renderer = new WorkspaceBrowserRenderer(
    () => temporary as never,
    () => 1,
  );
  let operations = 0;
  await assert.rejects(
    renderer.render(
      view as never,
      () => ({
        window: owner as never,
        isCurrent: () => true,
        invalidate: () => {},
      }),
      async () => {
        operations++;
      },
    ),
    (value) => value === error,
  );
  assert.equal(operations, 0);
  assert.equal(view.parent, owner);
  assert.equal(temporary.destroyed, true);
  assert.deepEqual(view.bounds, { x: 20, y: 30, width: 640, height: 480 });
});

for (const event of ["show", "restore"] as const) {
  for (const rejection of ["native", "timeout"] as const) {
    test(`${event} cleanup failure and later ${rejection} rejection retain both original causes`, async () => {
      const f = fixture(),
        entered = deferred(),
        finish = deferred();
      const cleanup = new Error("owner-event restore failure");
      const native = new Error("native capture failure");
      const result = f.render(async () => {
        if (rejection === "timeout") {
          f.view.webContents.capturePage = () => {
            entered.resolve();
            return new Promise(() => undefined);
          };
          return await captureWorkspacePage(
            f.view as never,
            () => undefined,
            20,
          );
        }
        entered.resolve();
        await finish.promise;
        throw native;
      });
      await entered.promise;
      f.owner.contentView.addChildView = () => {
        throw cleanup;
      };
      assert.doesNotThrow(() => f.owner.emit(event));
      finish.resolve();
      await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(
          error.errors.length,
          2,
          "each original cause appears once",
        );
        assert.equal(error.errors[1], cleanup);
        if (rejection === "native") assert.equal(error.errors[0], native);
        else assert.match(String(error.errors[0]), /native capture timed out/);
        return true;
      });
    });
  }
}

function frame(width = 640, height = 480, empty = false) {
  return { isEmpty: () => empty, getSize: () => ({ width, height }) };
}

test("synchronous pre-activation, empty and wrong-size frames cannot dispatch", async () => {
  const f = fixture();
  f.view.autoFrame = false;
  const subscribe = f.view.webContents.beginFrameSubscription;
  f.view.webContents.beginFrameSubscription = (dirty, callback) => {
    subscribe(dirty, callback);
    callback(frame());
  };
  let operations = 0;
  const pending = f.render(async () => {
    operations++;
  });
  await tick();
  assert.equal(operations, 0);
  f.view.frame!(frame(640, 480, true));
  f.view.frame!(frame(639, 480));
  f.view.frame!(frame(640, 481));
  await tick();
  assert.equal(operations, 0);
  f.view.frame!(frame());
  await pending;
  assert.equal(operations, 1);
  assert.equal(f.view.unsubscriptions, 1);
});

for (const scale of [1.25, 2]) {
  test(`frame dimensions use rounded physical pixels at ${scale}x, not DIP or CSS viewport`, async () => {
    const f = fixture();
    f.view.autoFrame = false;
    f.setScale(scale);
    let operations = 0;
    const pending = f.render(async () => {
      operations++;
    });
    await tick();
    f.view.frame!(frame());
    await tick();
    assert.equal(operations, 0);
    f.view.frame!(frame(Math.round(640 * scale), Math.round(480 * scale)));
    await pending;
    assert.equal(operations, 1);
    assert.equal(f.view.unsubscriptions, 1);
  });
}

test("a display-scale change in the same lease rejects an old-size frame", async () => {
  const f = fixture();
  f.view.autoFrame = false;
  let operations = 0;
  const pending = f.render(async () => {
    operations++;
  });
  const rejected = assert.rejects(pending, /view changed/);
  await tick();
  f.setScale(2);
  f.view.frame!(frame());
  await rejected;
  assert.equal(operations, 0);
  assert.equal(f.view.unsubscriptions, 1);
  assert.equal(f.view.parent, f.owner);
});

test("subscription setup failure cleans up without activating the temporary renderer", async () => {
  const f = fixture(),
    error = new Error("subscription failed");
  f.view.webContents.beginFrameSubscription = () => {
    f.view.subscriptions++;
    throw error;
  };
  await assert.rejects(
    f.render(async () => {
      assert.fail("dispatch forbidden");
    }),
    (value) => value === error,
  );
  assert.equal(f.view.unsubscriptions, 1);
  assert.equal(f.windows[0]!.inactiveShows, 0);
  assert.equal(f.view.parent, f.owner);
});

test("missing compositor frame times out with zero operation calls and restored owner", async () => {
  const f = fixture(5);
  f.view.autoFrame = false;
  await assert.rejects(
    f.render(async () => {
      assert.fail("dispatch forbidden");
    }),
    /compositor frame timed out/,
  );
  assert.equal(f.view.unsubscriptions, 1);
  assert.equal(f.view.parent, f.owner);
  assert.equal(f.windows[0]!.destroyed, true);
});

test("frame subscription cleanup failure prevents dispatch and retains the cleanup error", async () => {
  const f = fixture(),
    error = new Error("cannot stop subscription");
  f.view.webContents.endFrameSubscription = () => {
    f.view.unsubscriptions++;
    throw error;
  };
  await assert.rejects(
    f.render(async () => {
      assert.fail("dispatch forbidden");
    }),
    (value) => value === error,
  );
  assert.equal(f.view.unsubscriptions, 1);
  assert.equal(f.view.parent, f.owner);
});

test("native activation and subscription cleanup failures both remain visible", async () => {
  const f = fixture(),
    activation = new Error("showInactive failed"),
    cleanup = new Error("end subscription failed");
  const subscribe = f.view.webContents.beginFrameSubscription;
  f.view.webContents.beginFrameSubscription = (dirty, callback) => {
    subscribe(dirty, callback);
    f.view.parent!.showInactive = () => {
      throw activation;
    };
  };
  f.view.webContents.endFrameSubscription = () => {
    f.view.unsubscriptions++;
    throw cleanup;
  };
  await assert.rejects(
    f.render(async () => {
      assert.fail("dispatch forbidden");
    }),
    (value) =>
      value instanceof AggregateError &&
      value.errors[0] === activation &&
      value.errors[1] === cleanup,
  );
  assert.equal(f.view.unsubscriptions, 1);
  assert.equal(f.view.parent, f.owner);
});

test("abort during frame wait returns the owner immediately and keeps the original abort reason", async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = new Error("user cancelled");
  f.view.autoFrame = false;
  const pending = f.renderer.render(
    f.view as never,
    () => f.mount,
    async () => {
      assert.fail("dispatch forbidden");
    },
    controller.signal,
  );
  const rejected = assert.rejects(pending, (value) => value === reason);
  await tick();
  const late = f.view.frame!;
  controller.abort(reason);
  assert.equal(f.view.parent, f.owner);
  assert.equal(f.view.unsubscriptions, 1);
  late(frame());
  await rejected;
});

test("already-aborted queued render never allocates a renderer or subscribes", async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = new Error("cancelled before queue");
  controller.abort(reason);
  await assert.rejects(
    f.renderer.render(
      f.view as never,
      () => f.mount,
      async () => {
        assert.fail("dispatch forbidden");
      },
      controller.signal,
    ),
    (value) => value === reason,
  );
  assert.equal(f.windows.length, 0);
  assert.equal(f.view.subscriptions, 0);
});

test("late frame from a released lease cannot unlock the successor lease", async () => {
  const f = fixture();
  f.view.autoFrame = false;
  let operations = 0;
  const first = f.render(async () => {
    assert.fail("old dispatch forbidden");
  });
  const rejected = assert.rejects(first, /view changed/);
  await tick();
  const late = f.view.frame!;
  f.renderer.release(f.view as never);
  await rejected;
  const successor = new Window();
  successor.contentView.addChildView(f.view);
  const second = f.renderer.render(
    f.view as never,
    () => ({
      window: successor as never,
      isCurrent: () => true,
      invalidate() {},
    }),
    async () => {
      operations++;
    },
  );
  await tick();
  late(frame());
  await tick();
  assert.equal(operations, 0);
  f.view.frame!(frame());
  await second;
  assert.equal(operations, 1);
  assert.equal(f.view.unsubscriptions, 2);
  assert.equal(f.view.parent, successor);
});

test("closing during readiness stops the subscription and rejects every late frame", async () => {
  const f = fixture();
  f.view.autoFrame = false;
  const pending = f.render(async () => {
    assert.fail("dispatch forbidden");
  });
  const rejected = assert.rejects(pending, /view changed/);
  await tick();
  const late = f.view.frame!;
  f.renderer.close();
  assert.equal(f.view.unsubscriptions, 1);
  late(frame());
  await rejected;
});

test("successful frame clears the readiness timer before a longer native operation", async () => {
  const f = fixture(25),
    started = deferred(),
    done = deferred();
  const pending = f.render(async () => {
    started.resolve();
    await done.promise;
    return "captured once";
  });
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(f.view.unsubscriptions, 1);
  done.resolve();
  assert.equal(await pending, "captured once");
});

test("fractional backing scale uses rounding rather than capturePage ceil", async () => {
  const owner = new Window(),
    view = new View(),
    temporary = new Window();
  view.bounds = { x: 2, y: 3, width: 641, height: 481 };
  view.autoFrame = false;
  owner.contentView.addChildView(view);
  const renderer = new WorkspaceBrowserRenderer(
    () => temporary as never,
    () => 1.25,
  );
  let operations = 0;
  const pending = renderer.render(
    view as never,
    () => ({ window: owner as never, isCurrent: () => true, invalidate() {} }),
    async () => {
      operations++;
    },
  );
  await tick();
  view.frame!(frame(802, 602)); // ceil would accept this; FrameSubscriber rounds.
  await tick();
  assert.equal(operations, 0);
  view.frame!(frame(801, 601));
  await pending;
  assert.equal(operations, 1);
  assert.equal(view.unsubscriptions, 1);
});

test("abort plus subscription-stop failure retains both causes and still returns the view", async () => {
  const f = fixture(),
    controller = new AbortController(),
    aborted = new Error("cancelled"),
    cleanup = new Error("end failed");
  f.view.autoFrame = false;
  f.view.webContents.endFrameSubscription = () => {
    f.view.unsubscriptions++;
    throw cleanup;
  };
  const pending = f.renderer.render(
    f.view as never,
    () => f.mount,
    async () => {
      assert.fail("dispatch forbidden");
    },
    controller.signal,
  );
  const rejected = assert.rejects(
    pending,
    (value) =>
      value instanceof AggregateError &&
      value.errors[0] === aborted &&
      value.errors[1] === cleanup,
  );
  await tick();
  controller.abort(aborted);
  assert.equal(f.view.parent, f.owner);
  await rejected;
  assert.equal(f.view.unsubscriptions, 1);
});

test("a caller error after a valid frame is not replayed and never leaves a subscription", async () => {
  const f = fixture(),
    error = new Error("UnknownVizError");
  let captures = 0;
  await assert.rejects(
    f.render(async () => {
      captures++;
      throw error;
    }),
    (value) => value === error,
  );
  assert.equal(captures, 1);
  assert.equal(f.view.subscriptions, 1);
  assert.equal(f.view.unsubscriptions, 1);
  assert.equal(f.view.parent, f.owner);
});

for (const [width, height, decimalScale, expectedWidth, expectedHeight] of [
  [395, 301, 1.3, 514, 391],
  [390, 300, 1.15, 449, 345],
  [395, 301, 1.1, 435, 331],
  [395, 301, 1.35, 533, 406],
] as const) {
  test(`native float32 frame at ${decimalScale}x keeps exact ${expectedWidth}x${expectedHeight} acceptance`, async () => {
    const owner = new Window(),
      view = new View(),
      temporary = new Window();
    view.bounds = { x: 0, y: 0, width, height };
    view.autoFrame = false;
    owner.contentView.addChildView(view);
    const renderer = new WorkspaceBrowserRenderer(
      () => temporary as never,
      () => Math.fround(decimalScale),
    );
    let operations = 0;
    const pending = renderer.render(
      view as never,
      () => ({
        window: owner as never,
        isCurrent: () => true,
        invalidate() {},
      }),
      async () => {
        operations++;
      },
    );
    const settled = pending.catch(() => undefined);
    try {
      await tick();
      view.frame!(frame(expectedWidth - 1, expectedHeight));
      view.frame!(frame(expectedWidth + 1, expectedHeight));
      await tick();
      assert.equal(
        operations,
        0,
        "one-pixel tolerance must not weaken readiness",
      );
      view.frame!(frame(expectedWidth, expectedHeight));
      await pending;
      assert.equal(operations, 1);
      assert.equal(view.unsubscriptions, 1);
      assert.equal(view.parent, owner);
    } finally {
      renderer.close();
      await settled;
    }
  });
}

test("both native PNG dimension oracles preserve float32 ceil across scale boundaries", () => {
  const source = readFileSync(
    new URL("../src/main/workspace-browser-smoke.ts", import.meta.url),
    "utf8",
  );
  const expressions = [
    ...source.matchAll(
      /width: (Math\.ceil\([\s\S]*?\)),\s*height: (Math\.ceil\([\s\S]*?\)),(?=\s*\})/g,
    ),
  ];
  assert.equal(
    expressions.length,
    2,
    "both unmounted and hidden PNG oracles are exercised",
  );
  // Literal expected dimensions are derived from pinned gfx::ScaleToCeiledSize.
  for (const [
    decimalScale,
    unmountedWidth,
    unmountedHeight,
    mountedWidth,
    mountedHeight,
  ] of [
    [1, 1280, 800, 640, 480],
    [1.1, 1408, 880, 704, 528],
    [1.15, 1472, 920, 736, 552],
    [1.25, 1600, 1000, 800, 600],
    [1.3, 1664, 1040, 832, 624],
    [1.35, 1728, 1080, 864, 648],
    [1.5, 1920, 1200, 960, 720],
    [2, 2560, 1600, 1280, 960],
  ] as const) {
    for (const [index, match] of expressions.entries()) {
      const expected = runInNewContext(`({${match[0]}})`, {
        scale: Math.fround(decimalScale),
        captureScale: Math.fround(decimalScale),
      });
      assert.equal(
        expected.width,
        index === 0 ? unmountedWidth : mountedWidth,
        `oracle ${index} width at ${decimalScale}`,
      );
      assert.equal(
        expected.height,
        index === 0 ? unmountedHeight : mountedHeight,
        `oracle ${index} height at ${decimalScale}`,
      );
    }
  }
});

test("same-size stale readiness frame cannot bypass the request-driven redraw fence", async () => {
  const f = fixture(),
    redraw = deferred();
  f.view.autoFrame = false;
  let captures = 0;
  f.view.redraw = async () => {
    await redraw.promise;
    return {};
  };
  f.view.webContents.capturePage = async () => {
    captures++;
    return {};
  };
  const result = f.render(() =>
    captureWorkspacePage(f.view as never, () => {}),
  );
  await tick();
  f.view.frame!(frame());
  await tick();
  assert.equal(
    f.view.unsubscriptions,
    1,
    "the old surface is a valid readiness frame",
  );
  assert.equal(captures, 0, "readiness does not prove post-mutation pixels");
  redraw.resolve();
  await result;
  assert.equal(captures, 1);
  assert.equal(
    f.view.debuggerAttachments,
    0,
    "reuse the existing target debugger",
  );
});

test("redraw fence attaches only when needed and never detaches the shared debugger", async () => {
  const f = fixture();
  f.view.debuggerAttached = false;
  await f.render(() => captureWorkspacePage(f.view as never, () => {}));
  assert.equal(f.view.debuggerAttachments, 1);
  assert.equal(f.view.debuggerAttached, true);
});

test("redraw failure does not fall back to copying the stale surface", async () => {
  const f = fixture(),
    failure = new Error("redraw failed");
  f.view.redraw = async () => {
    throw failure;
  };
  f.view.webContents.capturePage = async () => {
    assert.fail("stale fallback forbidden");
  };
  await assert.rejects(
    f.render(() => captureWorkspacePage(f.view as never, () => {})),
    (error) => error === failure,
  );
  assert.equal(f.view.parent, f.owner);
});

test("a timed-out redraw never starts a late native copy", async () => {
  const f = fixture(),
    redraw = deferred();
  let invalidations = 0,
    captures = 0;
  f.view.redraw = async () => {
    await redraw.promise;
    return {};
  };
  f.view.webContents.capturePage = async () => {
    captures++;
    return {};
  };
  await assert.rejects(
    f.render(() =>
      captureWorkspacePage(
        f.view as never,
        () => {
          invalidations++;
        },
        5,
      ),
    ),
    /capture timed out/,
  );
  redraw.resolve();
  await tick();
  assert.equal(invalidations, 1);
  assert.equal(captures, 0);
  assert.equal(f.view.parent, f.owner);
});

test("owner takeover during redraw prevents the later native copy", async () => {
  const f = fixture(),
    redraw = deferred(),
    entered = deferred();
  let captures = 0;
  f.view.redraw = async () => {
    entered.resolve();
    await redraw.promise;
    return {};
  };
  f.view.webContents.capturePage = async () => {
    captures++;
    return {};
  };
  const result = f.render(() =>
    captureWorkspacePage(
      f.view as never,
      () => {},
      undefined,
      () => {
        if (!f.current())
          throw new Error(
            "Browser view changed during rendering; inspect again",
          );
      },
    ),
  );
  await entered.promise;
  f.owner.emit("show");
  redraw.resolve();
  await assert.rejects(result, /view changed/);
  assert.equal(captures, 0);
  assert.equal(f.view.parent, f.owner);
});

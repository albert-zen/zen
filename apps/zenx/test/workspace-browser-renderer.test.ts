import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  webContents = {
    isDestroyed: () => this.destroyed,
    capturePage: async () => ({}),
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
function fixture() {
  const owner = new Window(),
    view = new View();
  owner.contentView.addChildView(view);
  let current = true,
    invalidations = 0;
  const windows: Window[] = [];
  const renderer = new WorkspaceBrowserRenderer((options) => {
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
  });
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
    current: () => current,
    invalidations: () => invalidations,
    replace: () => {
      current = false;
    },
    render: <T>(operation: () => Promise<T>) =>
      renderer.render(view as never, () => mount, operation),
  };
}
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
  const renderer = new WorkspaceBrowserRenderer(() => temporary as never);
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

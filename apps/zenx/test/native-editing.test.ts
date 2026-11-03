import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createNativeEditingApi } from "../src/preload/native-editing.js";
import { ipcChannels } from "../src/preload/ipc.js";

function fixture(platform: NodeJS.Platform = "darwin") {
  const ipc = new EventEmitter();
  const timers = new Set<() => void>();
  const traffic: unknown[][] = [];
  const frame = {
    url: "file:///zenx/index.html",
    detached: false,
    isDestroyed: () => false,
    send: (...args: unknown[]) => traffic.push(args),
  };
  let selected = 0;
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    selectAll: () => selected++,
  });
  let focused: unknown = sender;
  let owned = true;
  const executable = ts.transpileModule(
    readFileSync(
      new URL("../src/main/native-editing.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: Record<string, (...args: any[]) => any> = {};
  runInNewContext(executable, {
    exports,
    require(name: string) {
      if (name === "electron")
        return {
          ipcMain: ipc,
          Menu: { sendActionToFirstResponder: () => selected++ },
          BrowserWindow: {
            fromWebContents: () => ({ id: 10, webContents: sender }),
          },
          webContents: { getFocusedWebContents: () => focused },
        };
      if (name.endsWith("/ipc.js")) return { ipcChannels };
      if (name.endsWith("/imzenx-setup-ipc.js"))
        return {
          isTrustedImZenXSetupSender: (
            value: { ownedWindow: boolean; mainFrame: boolean; url: string },
            url: string,
          ) => value.ownedWindow && value.mainFrame && value.url === url,
        };
      throw Error(`Unexpected import ${name}`);
    },
    setTimeout(callback: () => void) {
      timers.add(callback);
      return callback;
    },
    clearTimeout(callback: () => void) {
      timers.delete(callback);
    },
    process: { platform },
  });
  let menuChanges = 0;
  const service = exports.installNativeEditing!({
    rendererUrl: frame.url,
    ownsWindow: () => owned,
    menuChanged: () => menuChanges++,
    platform,
  });
  const event = { sender, senderFrame: frame };
  const register = (token = "registration-1", enabled = true, source = event) =>
    ipc.emit(ipcChannels.nativeEditingRegister, source, token, enabled);
  const ack = (token: unknown, id: unknown, source = event) =>
    ipc.emit(ipcChannels.nativeEditingPrepared, source, token, id, true);
  const lastRequest = () =>
    traffic.filter((x) => x[0] === ipcChannels.nativeEditingPrepare).at(-1)!;
  return {
    ipc,
    service,
    sender,
    frame,
    event,
    register,
    ack,
    lastRequest,
    traffic,
    timers,
    selected: () => selected,
    menuChanges: () => menuChanges,
    focus(value: unknown) {
      focused = value;
    },
    own(value: boolean) {
      owned = value;
    },
    input(input: Record<string, unknown>) {
      let prevented = false;
      sender.emit(
        "before-input-event",
        {
          preventDefault() {
            prevented = true;
          },
        },
        {
          type: "keyDown",
          key: "a",
          control: platform !== "darwin",
          meta: platform === "darwin",
          shift: false,
          alt: false,
          isComposing: false,
          ...input,
        },
      );
      return prevented;
    },
  };
}

test("main selects only after current focused main-frame ACK, never before preparation", () => {
  const f = fixture();
  assert.equal(f.service.available(), false);
  f.register();
  assert.equal(f.service.available(), true);
  f.service.selectAll();
  assert.equal(f.selected(), 0);
  const [, token, id] = f.lastRequest();
  f.ack(token, id);
  assert.equal(f.selected(), 1);
  assert.deepEqual(f.traffic.at(-1), [
    ipcChannels.nativeEditingCompleted,
    token,
    id,
    true,
  ]);
  f.ack(token, id);
  assert.equal(f.selected(), 1);
  f.service.close();
  assert.equal(f.timers.size, 0);
});

for (const cause of [
  "blur",
  "navigation",
  "unregister",
  "registration",
  "timeout",
  "focus",
  "foreign-frame",
])
  test(`late native selection ACK cannot cross ${cause}`, () => {
    const f = fixture();
    f.register();
    f.service.selectAll();
    const [, token, id] = f.lastRequest();
    if (cause === "blur") {
      f.focus(null);
      f.sender.emit("blur");
    }
    if (cause === "navigation")
      f.sender.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
      });
    if (cause === "unregister") f.register("registration-1", false);
    if (cause === "registration") f.register("registration-2");
    if (cause === "timeout") for (const timer of [...f.timers]) timer();
    if (cause === "focus") f.focus({});
    if (cause === "foreign-frame") {
      f.ack(token, id, { sender: f.sender, senderFrame: { ...f.frame } });
      assert.equal(f.selected(), 0);
      f.service.close();
      return;
    }
    f.ack(token, id);
    assert.equal(f.selected(), 0);
    assert.ok(
      f.traffic.some(
        (x) =>
          x[0] === ipcChannels.nativeEditingCompleted &&
          x[2] === id &&
          x[3] === false,
      ),
    );
    f.service.close();
  });

test("same-document navigation is not replacement; repeated request retires only older ACK", () => {
  const f = fixture();
  f.register();
  f.service.selectAll();
  const [, token, first] = f.lastRequest();
  f.service.selectAll();
  const [, , second] = f.lastRequest();
  assert.notEqual(first, second);
  f.ack(token, first);
  assert.equal(f.selected(), 0);
  f.sender.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: true,
  });
  f.ack(token, second);
  assert.equal(f.selected(), 1);
  f.service.close();
});

test("registration rejects subframes, foreign windows and non-exact payload types", () => {
  const f = fixture();
  f.register("registration-1", true, {
    sender: f.sender,
    senderFrame: { ...f.frame },
  });
  assert.equal(f.service.available(), false);
  f.own(false);
  f.register();
  assert.equal(f.service.available(), false);
  f.own(true);
  f.register("invalid token");
  assert.equal(f.service.available(), false);
  f.service.close();
});

function preloadFixture() {
  const ipc = new EventEmitter();
  const sent: unknown[][] = [];
  let token = 0;
  const api = createNativeEditingApi(
    Object.assign(ipc, { send: (...args: unknown[]) => sent.push(args) }),
    () => `preload-${++token}`,
  );
  return {
    ipc,
    api,
    sent,
    token: () =>
      sent.findLast((x) => x[0] === ipcChannels.nativeEditingRegister)![1],
  };
}

test("preload runs synchronous DOM preparation before ACK and strips all event payload", () => {
  const f = preloadFixture();
  const order: string[] = [];
  const off = f.api.onPrepareSelectAll((...args) => {
    assert.equal(args.length, 0);
    order.push("commit");
    return true;
  });
  f.ipc.emit(
    ipcChannels.nativeEditingPrepare,
    { privateEvent: true },
    f.token(),
    1,
  );
  order.push(
    f.sent.at(-1)?.[0] === ipcChannels.nativeEditingPrepared ? "ack" : "wrong",
  );
  assert.deepEqual(order, ["commit", "ack"]);
  off();
  assert.equal(f.ipc.listenerCount(ipcChannels.nativeEditingPrepare), 0);
});

test("preload cancels failed preparation only, never a successful native selection", () => {
  const f = preloadFixture();
  let cancelled = 0;
  f.api.onSelectAllCancelled(() => cancelled++);
  const off = f.api.onPrepareSelectAll(() => true);
  const token = f.token();
  const prepare = (id: number) =>
    f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, token, id);
  const complete = (id: number, ok: boolean) =>
    f.ipc.emit(ipcChannels.nativeEditingCompleted, {}, token, id, ok);
  prepare(1);
  complete(1, true);
  assert.equal(cancelled, 0);
  prepare(2);
  prepare(3);
  assert.equal(cancelled, 1);
  complete(2, false);
  assert.equal(cancelled, 1);
  complete(3, false);
  assert.equal(cancelled, 2);
  prepare(4);
  off();
  assert.equal(cancelled, 3);
  complete(4, false);
  assert.equal(cancelled, 3);
  off();
  assert.equal(cancelled, 3);
});

test("preload editor/default false has native ACK but no transcript cancellation", () => {
  const f = preloadFixture();
  let cancelled = 0;
  f.api.onSelectAllCancelled(() => cancelled++);
  const off = f.api.onPrepareSelectAll(() => false);
  f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, f.token(), 1);
  assert.equal(f.sent.at(-1)?.[0], ipcChannels.nativeEditingPrepared);
  f.ipc.emit(ipcChannels.nativeEditingCompleted, {}, f.token(), 1, false);
  assert.equal(cancelled, 0);
  off();
});

test("preload rejects stale registration requests and late completion after re-register", () => {
  const f = preloadFixture();
  let commits = 0;
  const first = f.api.onPrepareSelectAll(() => {
    commits++;
    return true;
  });
  const old = f.token();
  first();
  const second = f.api.onPrepareSelectAll(() => {
    commits++;
    return true;
  });
  f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, old, 1);
  assert.equal(commits, 0);
  f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, f.token(), 2);
  assert.equal(commits, 1);
  f.ipc.emit(ipcChannels.nativeEditingCompleted, {}, old, 2, false);
  second();
});

test("preload keeps menu registration stable while editor keyboard selection stays local", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<body tabindex="0"><input><textarea></textarea><div class="cm-editor" tabindex="0"></div><div class="xterm" tabindex="0"></div><div contenteditable="plaintext-only" tabindex="0"></div><iframe></iframe></body>',
  );
  const ipc = new EventEmitter();
  const sent: unknown[][] = [];
  const api = createNativeEditingApi(
    Object.assign(ipc, { send: (...args: unknown[]) => sent.push(args) }),
    () => "focus-registration",
    dom.window.document,
  );
  const off = api.onPrepareSelectAll(() => true);
  assert.equal(sent.at(-1)?.[2], true);
  for (const element of dom.window.document.querySelectorAll<HTMLElement>(
    "input,textarea,.cm-editor,.xterm,[contenteditable],iframe",
  )) {
    element.focus();
    assert.equal(
      sent.at(-1)?.[2],
      true,
      `${element.tagName} keeps the menu request responder registered`,
    );
    dom.window.document.body.focus();
    assert.equal(sent.at(-1)?.[2], true);
  }
  off();
  assert.equal(sent.at(-1)?.[2], false);
  dom.window.close();
});

test("preload cancels a partial throwing preparation and sends an explicit failed ACK", () => {
  const f = preloadFixture();
  let cancelled = 0;
  f.api.onSelectAllCancelled(() => cancelled++);
  const off = f.api.onPrepareSelectAll(() => {
    throw Error("partial commit");
  });
  f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, f.token(), 1);
  assert.equal(cancelled, 1);
  assert.equal(f.sent.at(-1)?.[3], false);
  off();
});

test("preload preparation subscription changes retire the old registration epoch", () => {
  const f = preloadFixture();
  let cancelled = 0;
  f.api.onSelectAllCancelled(() => cancelled++);
  const first = f.api.onPrepareSelectAll(() => true);
  const old = f.token();
  f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, old, 1);
  const second = f.api.onPrepareSelectAll(() => false);
  assert.equal(cancelled, 1);
  assert.notEqual(old, f.token());
  const before = f.sent.length;
  f.ipc.emit(ipcChannels.nativeEditingPrepare, {}, old, 2);
  assert.equal(f.sent.length, before);
  first();
  second();
});

test("actual macOS menu uses native role by default and only the registered bridge has custom click", () => {
  let template: any[] = [];
  const executable = ts.transpileModule(
    readFileSync(
      new URL("../src/main/application-menu.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: Record<string, (...args: any[]) => any> = {};
  runInNewContext(executable, {
    exports,
    process: { platform: "darwin" },
    require(name: string) {
      if (name === "electron")
        return {
          Menu: {
            buildFromTemplate(value: any[]) {
              template = value;
              return value;
            },
            setApplicationMenu() {},
          },
        };
      if (name.endsWith("native-locale.js"))
        return { nativeText: (key: string) => key };
      throw Error(name);
    },
  });
  const select = () =>
    template
      .find((x) => x.label === "edit")
      .submenu.find((x: any) => x.label === "selectAll");
  exports.installApplicationMenu!("darwin");
  assert.equal(select().role, "selectAll");
  assert.equal(select().click, undefined);
  let prepared = 0;
  exports.installApplicationMenu!("darwin", {
    available: () => true,
    selectAll: () => prepared++,
  });
  assert.equal(select().role, undefined, "role would ignore click on macOS");
  assert.equal(select().accelerator, "CommandOrControl+A");
  select().click();
  assert.equal(prepared, 1);
  exports.installApplicationMenu!("darwin", {
    available: () => false,
    selectAll() {},
  });
  assert.equal(select().role, "selectAll");
});

for (const platform of ["darwin", "win32", "linux"])
  test(`${platform} real DOM key capture prepares before default without swallowing editor keys`, async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(
      '<body tabindex="0"><input><div class="cm-editor" tabindex="0"></div><div class="xterm" tabindex="0"></div></body>',
    );
    const ipc = new EventEmitter();
    let commits = 0;
    const api = createNativeEditingApi(
      Object.assign(ipc, { send() {} }),
      () => "keyboard",
      dom.window.document,
      platform,
    );
    const off = api.onPrepareSelectAll(() => {
      commits++;
      return true;
    });
    const key = () =>
      new dom.window.KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: platform !== "darwin",
        metaKey: platform === "darwin",
        bubbles: true,
        cancelable: true,
      });
    for (const target of dom.window.document.querySelectorAll<HTMLElement>(
      "input,.cm-editor,.xterm",
    )) {
      target.focus();
      const event = key();
      target.dispatchEvent(event);
      assert.equal(commits, 0);
      assert.equal(event.defaultPrevented, false);
    }
    dom.window.document.body.focus();
    const event = key();
    dom.window.document.body.dispatchEvent(event);
    assert.equal(commits, 1);
    assert.equal(event.defaultPrevented, false);
    const editor = dom.window.document.querySelector(".cm-editor")!;
    // A contenteditable mutation without any new focus event must also keep the
    // first key native, even while main's registration is still enabled.
    dom.window.document.body.setAttribute("contenteditable", "plaintext-only");
    const second = key();
    dom.window.document.body.dispatchEvent(second);
    assert.equal(commits, 1);
    assert.equal(second.defaultPrevented, false);
    assert.ok(editor);
    off();
    dom.window.close();
  });

test("preload lost completion timer is request-bound and never cancels an existing Selection", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<body><div>Canonical transcript text</div></body>");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ipc = new EventEmitter();
  let cancelled = 0;
  const api = createNativeEditingApi(
    Object.assign(ipc, { send() {} }),
    () => "timer",
    dom.window.document,
  );
  const offCancel = api.onSelectAllCancelled(() => cancelled++);
  const off = api.onPrepareSelectAll(() => true);
  const prepare = (id: number) =>
    ipc.emit(ipcChannels.nativeEditingPrepare, {}, "timer", id);
  prepare(1);
  t.mock.timers.tick(1000);
  prepare(2);
  assert.equal(cancelled, 1, "new preparation cancels the old request once");
  t.mock.timers.tick(500);
  assert.equal(cancelled, 1, "old timer cannot cancel newer preparation");
  t.mock.timers.tick(1000);
  assert.equal(
    cancelled,
    2,
    "lost completion with no Selection releases current preparation",
  );
  prepare(3);
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.body);
  dom.window.document.getSelection()!.addRange(range);
  t.mock.timers.tick(1500);
  assert.equal(
    cancelled,
    2,
    "actual Selection remains owned by renderer lifecycle",
  );
  off();
  offCancel();
  dom.window.close();
});

test("main safely retires a request when its captured frame cannot receive IPC", () => {
  const f = fixture();
  f.register();
  f.frame.send = () => {
    throw Error("frame detached between checks");
  };
  assert.doesNotThrow(() => f.service.selectAll());
  assert.equal(f.selected(), 0);
  assert.equal(f.timers.size, 0);
  assert.doesNotThrow(() => f.service.close());
});

test("first macOS editor menu intent survives an unprocessed focus registration message", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<body><textarea></textarea></body>");
  const f = fixture();
  const renderer = new EventEmitter();
  const delayed: unknown[][] = [];
  const ipc = Object.assign(renderer, {
    send(channel: string, ...args: unknown[]) {
      if (channel === ipcChannels.nativeEditingRegister && args[1] === false)
        delayed.push([channel, ...args]);
      else f.ipc.emit(channel, f.event, ...args);
    },
  });
  f.frame.send = (...args: unknown[]) => {
    renderer.emit(args[0] as string, {}, ...args.slice(1));
    return f.traffic.push(args);
  };
  const api = createNativeEditingApi(
    ipc,
    () => "focused-menu",
    dom.window.document,
    "darwin",
  );
  const off = api.onPrepareSelectAll(
    () => dom.window.document.activeElement?.tagName !== "TEXTAREA",
  );
  assert.equal(f.service.available(), true);
  dom.window.document.querySelector("textarea")!.focus();
  // Model an OS menu event overtaking the focus-related renderer→main packet.
  // The still-installed custom menu must not swallow this first editor action.
  f.service.selectAll();
  assert.equal(
    f.selected(),
    1,
    "first editor menu action must reach native responder exactly once",
  );
  assert.equal(f.timers.size, 0, "no unanswered preparation request remains");
  off();
  f.service.close();
  dom.window.close();
});

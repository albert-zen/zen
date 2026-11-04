import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Message = Record<string, any>;
const autoAttach = (enabled = true) => ({
  autoAttach: enabled,
  flatten: true,
  waitForDebuggerOnStart: false,
  filter: [{ type: "iframe", exclude: false }, { exclude: true }],
});

class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  messages: Message[] = [];
  send(raw: string) {
    this.messages.push(JSON.parse(raw));
  }
  receive(message: Message) {
    this.emit("message", JSON.stringify(message));
  }
  close() {
    if (this.readyState === 1) {
      this.readyState = 3;
      this.emit("close");
    }
  }
  terminate() {
    this.close();
  }
}

// Execute the production bridge with inert transport adapters. This exercises
// private routing/lifecycle code without listening on a port or launching Chrome.
async function fixture(iframeSessions = true) {
  const servers: Array<EventEmitter & { clients: Set<Socket> }> = [];
  class SocketServer extends EventEmitter {
    clients = new Set<Socket>();
    constructor() {
      super();
      servers.push(this);
    }
    close(done: () => void) {
      done();
    }
  }
  const http = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, done: () => void) {
      done();
    },
    address() {
      return { port: 31234 };
    },
    close(done: () => void) {
      done();
    },
  });
  const source = await readFile(
    new URL("../src/main/chrome-extension-bridge.ts", import.meta.url),
    "utf8",
  );
  const exports: Message = {};
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
    {
      exports,
      require(name: string) {
        if (name === "node:crypto") return { randomUUID, randomBytes };
        if (name === "node:http") return { createServer: () => http };
        if (name === "node:fs/promises")
          return Object.fromEntries(
            ["mkdir", "rename", "unlink", "writeFile"].map((key) => [
              key,
              async () => {},
            ]),
          );
        if (name === "node:path") return path;
        if (name === "ws")
          return {
            __esModule: true,
            default: Socket,
            WebSocketServer: SocketServer,
          };
        if (name === "./capabilities/user-browser-provider.js") return {};
        throw new Error(`Unexpected bridge dependency: ${name}`);
      },
      URL,
      setTimeout,
      clearTimeout,
      process: { pid: 1 },
    },
  );
  const bridge = await exports.ChromeExtensionBridge.start({
    runtimeDirectory: "/synthetic",
  });
  const native = new Socket();
  servers[0]!.emit("connection", native);
  native.receive({
    type: "hello",
    protocolVersion: 3,
    scope: "browser",
    capabilities: { iframeSessions },
  });
  native.receive({
    type: "browser-connected",
    tabs: [{ id: 7, title: "Root", url: "https://root.test/" }],
  });
  const connect = () => {
    const socket = new Socket();
    servers[1]!.emit("connection", socket, { url: "/devtools/browser/test" });
    return socket;
  };
  const client = connect();
  let id = 0;
  const request = (
    socket: Socket,
    method: string,
    params: Message = {},
    sessionId?: string,
  ) => {
    const next = ++id;
    socket.receive({
      id: next,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return next;
  };
  const response = (socket: Socket, requestId: number) =>
    socket.messages.find((message) => message.id === requestId);
  const attach = (socket = client) =>
    response(
      socket,
      request(socket, "Target.attachToTarget", {
        targetId: "chrome-tab-7",
        flatten: true,
      }),
    )!.result.sessionId as string;
  const latestCommand = () =>
    native.messages.findLast((message) => message.type === "cdp-command")!;
  const settle = (command = latestCommand(), failed = false) =>
    native.receive({
      type: "cdp-result",
      requestId: command.requestId,
      ...(failed
        ? { error: { message: "Native cleanup failed" } }
        : { result: {} }),
    });
  const event = (
    root: string,
    method: string,
    params: Message,
    nativeSessionId?: string,
  ) =>
    native.receive({
      type: "cdp-event",
      tabId: 7,
      rootSessionId: root,
      method,
      params,
      ...(nativeSessionId === undefined ? {} : { sessionId: nativeSessionId }),
    });
  const attachEvent = (
    root: string,
    nativeId: string,
    parent?: string,
    type = "iframe",
  ) =>
    event(
      root,
      "Target.attachedToTarget",
      {
        sessionId: nativeId,
        targetInfo: {
          targetId: `target-${nativeId}`,
          type,
          url: "https://child.test/",
        },
        waitingForDebugger: false,
      },
      parent,
    );
  const enable = (root: string, sessionId = root) => {
    const n = request(client, "Target.setAutoAttach", autoAttach(), sessionId);
    settle();
    assert.deepEqual(response(client, n)!.result, {});
  };
  return {
    bridge,
    client,
    native,
    connect,
    request,
    response,
    attach,
    latestCommand,
    settle,
    event,
    attachEvent,
    enable,
  };
}

test("Chrome 120 retains root commands and explicitly declines iframe capability", async () => {
  const f = await fixture(false);
  const root = f.attach();
  const caps = f.response(
    f.client,
    f.request(f.client, "ZenX.getCapabilities"),
  )!.result;
  assert.equal(caps.iframeSessions, false);
  assert.match(caps.limitation, /Chrome 125/);
  const n = f.request(f.client, "Target.setAutoAttach", autoAttach(), root);
  assert.match(f.response(f.client, n)!.error.message, /Chrome 125/);
  const ordinary = f.request(f.client, "Page.enable", {}, root);
  assert.equal(f.latestCommand().sessionId, undefined);
  f.settle();
  assert.deepEqual(f.response(f.client, ordinary)!.result, {});
  await f.bridge.close();
});

test("only trusted iframe events create exact root/socket child routes", async () => {
  const f = await fixture();
  const root = f.attach();
  const other = f.connect();
  const otherRoot = f.attach(other);
  const broad = f.request(
    f.client,
    "Target.setAutoAttach",
    { ...autoAttach(), filter: [{ exclude: false }] },
    root,
  );
  assert.ok(f.response(f.client, broad)!.error);
  f.enable(root);
  const competing = f.request(
    other,
    "Target.setAutoAttach",
    autoAttach(),
    otherRoot,
  );
  assert.match(f.response(other, competing)!.error.message, /pinned/);
  const before = f.client.messages.length;
  f.attachEvent(root, "worker", undefined, "worker");
  f.attachEvent(root, "unknown-parent", "not-attached");
  f.attachEvent(otherRoot, "wrong-owner");
  assert.equal(f.client.messages.length, before);
  f.attachEvent(root, "native-child");
  const attached = f.client.messages.at(-1)!;
  assert.equal(attached.sessionId, root);
  const child = attached.params.sessionId;
  assert.notEqual(child, "native-child");
  assert.equal(
    other.messages.some(
      (message) => message.method === "Target.attachedToTarget",
    ),
    false,
  );
  const stolen = f.request(other, "Runtime.evaluate", {}, child);
  const native = f.request(f.client, "Runtime.evaluate", {}, "native-child");
  assert.ok(f.response(other, stolen)!.error);
  assert.ok(f.response(f.client, native)!.error);
  const n = f.request(
    f.client,
    "DOM.getFrameOwner",
    { frameId: "frame" },
    child,
  );
  assert.equal(f.latestCommand().sessionId, "native-child");
  assert.equal(f.latestCommand().rootSessionId, root);
  f.settle();
  assert.equal(f.response(f.client, n)!.sessionId, child);
  f.event(
    root,
    "Runtime.executionContextCreated",
    { context: { id: 11 } },
    "native-child",
  );
  assert.equal(f.client.messages.at(-1)!.sessionId, child);
  const discovery = f.request(
    f.client,
    "Target.attachToTarget",
    { targetId: "chrome-tab-7" },
    child,
  );
  assert.ok(f.response(f.client, discovery)!.error);
  await f.bridge.close();
});

test("child navigation and subtree detach never rewrite or retire the root", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const child = f.client.messages.at(-1)!.params.sessionId;
  f.enable(root, child);
  f.attachEvent(root, "grandchild", "child");
  const grandchild = f.client.messages.at(-1)!.params.sessionId;
  f.event(
    root,
    "Page.frameNavigated",
    { frame: { id: "child-frame", url: "https://child.test/navigated" } },
    "child",
  );
  const navigate = f.request(
    f.client,
    "Page.navigate",
    { url: "https://child.test/again" },
    child,
  );
  f.settle();
  assert.deepEqual(f.response(f.client, navigate)!.result, {});
  const targets = f.response(
    f.client,
    f.request(f.client, "Target.getTargets"),
  )!.result.targetInfos;
  assert.equal(targets[0].url, "https://root.test/");
  const pending = f.request(f.client, "Runtime.evaluate", {}, grandchild);
  f.event(root, "Target.detachedFromTarget", { sessionId: "child" });
  assert.ok(f.response(f.client, pending)!.error);
  for (const stale of [child, grandchild])
    assert.ok(
      f.response(f.client, f.request(f.client, "Page.enable", {}, stale))!
        .error,
    );
  f.request(f.client, "Page.enable", {}, root);
  assert.equal(f.latestCommand().sessionId, undefined);
  assert.equal(f.bridge.status().tabCount, 1);
  await f.bridge.close();
});

test("root teardown confirms cleanup but pins shared autoattach to the retired lease", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const child = f.client.messages.at(-1)!.params.sessionId;
  const pending = f.request(f.client, "Runtime.evaluate", {}, child);
  const oldCommand = f.latestCommand();
  const otherRoot = f.attach();
  const detached = f.request(f.client, "Target.detachFromTarget", {
    sessionId: root,
  });
  const cleanup = f.latestCommand();
  assert.equal(cleanup.method, "Target.setAutoAttach");
  assert.equal(cleanup.params.autoAttach, false);
  assert.equal(f.response(f.client, detached), undefined);
  assert.ok(f.response(f.client, pending)!.error);
  const denied = f.request(
    f.client,
    "Target.setAutoAttach",
    autoAttach(),
    otherRoot,
  );
  assert.ok(f.response(f.client, denied)!.error);
  f.settle(oldCommand);
  assert.equal(
    f.client.messages.filter((message) => message.id === pending).length,
    1,
  );
  f.settle(cleanup);
  assert.deepEqual(f.response(f.client, detached)!.result, {});
  const successor = f.request(
    f.client,
    "Target.setAutoAttach",
    autoAttach(),
    otherRoot,
  );
  assert.match(
    f.response(f.client, successor)!.error.message,
    /pinned.*reconnect/,
  );
  const ordinary = f.request(f.client, "Page.enable", {}, otherRoot);
  f.settle();
  assert.deepEqual(f.response(f.client, ordinary)!.result, {});
  f.attachEvent(root, "late-old-child");
  assert.equal(
    f.client.messages.some(
      (message) =>
        message.params?.targetInfo?.targetId === "target-late-old-child",
    ),
    false,
  );
  await f.bridge.close();
});

test("unconfirmed cleanup blocks transfer; socket and transport retirement fence old children", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const child = f.client.messages.at(-1)!.params.sessionId;
  f.client.close();
  const cleanup = f.latestCommand();
  assert.equal(cleanup.params.autoAttach, false);
  f.settle(cleanup, true);
  const other = f.connect();
  const otherRoot = f.attach(other);
  assert.ok(
    f.response(
      other,
      f.request(other, "Target.setAutoAttach", autoAttach(), otherRoot),
    )!.error,
  );
  assert.ok(
    f.response(other, f.request(other, "Page.enable", {}, child))!.error,
  );
  f.native.close();
  assert.equal(f.bridge.status().tabCount, 0);
  assert.ok(
    f.response(other, f.request(other, "Page.enable", {}, otherRoot))!.error,
  );
  await f.bridge.close();
});

test("child route admission is bounded and requires each recursive parent's subscription", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const child = f.client.messages.at(-1)!.params.sessionId;
  const before = f.client.messages.length;
  f.attachEvent(root, "unsubscribed-grandchild", "child");
  assert.equal(f.client.messages.length, before);
  f.enable(root, child);
  for (let i = 0; i < 70; i++) f.attachEvent(root, `sibling-${i}`);
  assert.equal(
    f.client.messages.filter(
      (message) => message.method === "Target.attachedToTarget",
    ).length,
    64,
  );
  await f.bridge.close();
});

test("frame attachment events remain scoped and subscription changes cannot overlap", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const child = f.client.messages.at(-1)!.params.sessionId;
  f.event(root, "Page.frameAttached", {
    frameId: "local-frame",
    parentFrameId: "main",
  });
  assert.equal(f.client.messages.at(-1)!.sessionId, root);
  f.event(
    root,
    "Page.frameAttached",
    { frameId: "nested-frame", parentFrameId: "remote-main" },
    "child",
  );
  assert.equal(f.client.messages.at(-1)!.sessionId, child);
  const input = f.request(
    f.client,
    "Input.dispatchMouseEvent",
    { type: "mousePressed" },
    child,
  );
  assert.match(f.response(f.client, input)!.error.message, /root tab/);
  f.request(f.client, "Target.setAutoAttach", autoAttach(false), root);
  const disable = f.latestCommand();
  const overlap = f.request(
    f.client,
    "Target.setAutoAttach",
    autoAttach(),
    root,
  );
  assert.match(f.response(f.client, overlap)!.error.message, /still pending/);
  f.settle(disable, true);
  const retry = f.request(f.client, "Target.setAutoAttach", autoAttach(), root);
  assert.match(f.response(f.client, retry)!.error.message, /reconnect/);
  await f.bridge.close();
});

test("explicit child detach translates only the known parent and keeps the root reserved", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const child = f.client.messages.at(-1)!.params.sessionId;
  f.enable(root, child);
  f.attachEvent(root, "grandchild", "child");
  const grandchild = f.client.messages.at(-1)!.params.sessionId;
  const badParent = f.request(
    f.client,
    "Target.detachFromTarget",
    { sessionId: grandchild },
    root,
  );
  assert.ok(f.response(f.client, badParent)!.error);
  const detached = f.request(
    f.client,
    "Target.detachFromTarget",
    { sessionId: grandchild },
    child,
  );
  assert.equal(f.latestCommand().sessionId, "child");
  assert.equal(f.latestCommand().params.sessionId, "grandchild");
  f.settle();
  assert.deepEqual(f.response(f.client, detached)!.result, {});
  assert.ok(
    f.response(f.client, f.request(f.client, "Page.enable", {}, grandchild))!
      .error,
  );
  const otherRoot = f.attach();
  assert.ok(
    f.response(
      f.client,
      f.request(f.client, "Target.setAutoAttach", autoAttach(), otherRoot),
    )!.error,
  );
  await f.bridge.close();
});

test("same live root can resubscribe without reviving retired native IDs", async () => {
  const f = await fixture();
  const root = f.attach();
  f.enable(root);
  f.attachEvent(root, "child");
  const oldChild = f.client.messages.at(-1)!.params.sessionId;
  f.request(f.client, "Target.setAutoAttach", autoAttach(false), root);
  f.settle();
  const successor = root;
  f.enable(successor);
  const before = f.client.messages.length;
  f.attachEvent(successor, "child");
  f.event(
    successor,
    "Page.frameNavigated",
    { frame: { url: "https://stale.test/" } },
    "child",
  );
  assert.equal(f.client.messages.length, before);
  f.attachEvent(successor, "new-native-child");
  const nextChild = f.client.messages.at(-1)!.params.sessionId;
  assert.notEqual(nextChild, oldChild);
  assert.equal(f.client.messages.at(-1)!.sessionId, successor);
  await f.bridge.close();
});

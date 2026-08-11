import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  connectUserBrowserCdp,
  userBrowserDocumentEventInvalidates,
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
  validateUserBrowserVersion,
  windowsBrowserExecutableCandidates,
} from "../src/main/capabilities/user-browser-provider.js";

test("CDP lifecycle contract invalidates history, reload, activation, and top-frame navigation", () => {
  for (const method of [
    "Page.navigatedWithinDocument",
    "Page.frameStartedLoading",
    "Page.backForwardCacheNotUsed",
  ]) {
    assert.equal(
      userBrowserDocumentEventInvalidates(method, { frameId: "main" }, "main"),
      true,
      method,
    );
    assert.equal(
      userBrowserDocumentEventInvalidates(method, { frameId: "child" }, "main"),
      false,
      `${method} subframe`,
    );
  }
  assert.equal(
    userBrowserDocumentEventInvalidates("Page.frameNavigated", {
      frame: { id: "main", loaderId: "loader", url: "https://example.test" },
    }),
    true,
  );
  assert.equal(
    userBrowserDocumentEventInvalidates("Page.frameNavigated", {
      frame: { id: "child", parentId: "main" },
    }),
    false,
  );
});

test("user browser mode inherits visible authenticated state without exposing session material", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);

  const tabs = await backend.listTabs("work");
  assert.deepEqual(tabs, [
    {
      sessionId: "work",
      tabId: "target-1",
      title: "Account",
      url: "https://example.test/account",
      loading: false,
    },
  ]);

  const inspection = await backend.inspect("work", "target-1");
  assert.match(inspection.visibleText, /Signed in as Alice/u);
  assert.equal(inspection.targets[0]?.name, "Continue");
  assert.doesNotMatch(
    JSON.stringify({ tabs, inspection }),
    /cookie|storageState|authorization|secret-cookie-value/iu,
  );

  const target = inspection.targets[0];
  assert.ok(target);
  await backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  assert.equal(client.actionCount, 1);
  assert.equal(
    client.calls.some((call) =>
      /cookie|storage|authorization|network\./iu.test(call),
    ),
    false,
  );
});

test("closing user browser capability only detaches and never closes user targets", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");

  assert.equal(await backend.closeSession("work"), 1);
  await backend.close();

  assert.equal(client.closeCount, 1);
  assert.equal(client.closedTargets.length, 0);
});

test("detaching a user tab keeps it open and out of the logical ZenX session", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  await backend.closeTab("work", "target-1");
  assert.deepEqual(await backend.listTabs("work"), []);
  assert.deepEqual(client.closedTargets, []);
});

test("external navigation makes an attached-tab observation fail closed", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);

  client.currentUrl = "https://example.test/other";
  client.documentToken = "document-b";
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /document changed/u,
  );
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown/u,
  );
});

test("listing after external navigation invalidates the old observation before dispatch", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.currentUrl = "https://example.test/other";
  await backend.listTabs("work");
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown/u,
  );
  assert.equal(client.actionCount, 0);
});

test("cancelled action is outcome-unknown and its observation cannot be retried", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdActions = true;
  const controller = new AbortController();
  const action = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
    controller.signal,
  );
  await client.actionStarted;
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(action, /outcome is unknown/u);
  await assert.rejects(
    backend.inspect("work", "target-1"),
    /operation is already in flight/u,
  );
  await assert.rejects(
    backend.navigate("work", "target-1", "https://example.test/retry"),
    /operation is already in flight/u,
  );
  assert.equal(client.actionCount, 1);
  assert.equal(client.navigateCount, 0);
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown/u,
  );
  client.releaseAction();
  await client.actionSettled;
  await nextTurn();
  await backend.inspect("work", "target-1");
});

test("provider-owned lifecycle invalidates same-document history reload and activation observations", async () => {
  for (const lifecycle of [
    "pushState",
    "replaceState-same-url",
    "reload",
    "bfcache-activation",
  ]) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    client.advanceDocument(lifecycle);
    await assert.rejects(
      backend.click(
        "work",
        "target-1",
        inspection.observationId,
        target.targetId,
      ),
      /document changed/u,
    );
    assert.equal(client.actionCount, 0, lifecycle);
  }
});

test("target disappearance and disconnect fail before action dispatch", async () => {
  for (const failure of ["target disappeared", "CDP disconnected"]) {
    const client = new FakeUserBrowserClient();
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    client.identityFailure = new Error(failure);
    await assert.rejects(
      backend.click(
        "work",
        "target-1",
        inspection.observationId,
        target.targetId,
      ),
      /outcome is unknown/u,
    );
    assert.equal(client.actionCount, 0, failure);
  }
});

test("post-confirmation cancellation retains the tab fence until confirmation settles", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdPostConfirmation = true;
  const controller = new AbortController();
  const action = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
    controller.signal,
  );
  await client.postConfirmationStarted;
  controller.abort();
  await assert.rejects(action, /outcome is unknown/u);
  await assert.rejects(backend.inspect("work", "target-1"), /in flight/u);
  await assert.rejects(
    backend.navigate("work", "target-1", "https://example.test/retry"),
    /in flight/u,
  );
  assert.equal(client.navigateCount, 0);
  client.releasePostConfirmation();
  await client.postConfirmationSettled;
  await nextTurn();
  await backend.inspect("work", "target-1");
  assert.equal(client.actionCount, 1);
});

test("navigate is exclusive and detach waits for an already dispatched action", async () => {
  const navigationClient = new FakeUserBrowserClient();
  const navigationBackend = new UserBrowserCdpBackend(navigationClient);
  await navigationBackend.listTabs("work");
  navigationClient.holdNavigations = true;
  const firstNavigate = navigationBackend.navigate(
    "work",
    "target-1",
    "https://example.test/next",
  );
  await navigationClient.navigationStarted;
  await assert.rejects(
    navigationBackend.navigate(
      "work",
      "target-1",
      "https://example.test/other",
    ),
    /operation is already in flight/u,
  );
  assert.equal(navigationClient.navigateCount, 1);
  navigationClient.releaseNavigation();
  await firstNavigate;

  const actionClient = new FakeUserBrowserClient();
  const actionBackend = new UserBrowserCdpBackend(actionClient);
  await actionBackend.listTabs("work");
  const inspection = await actionBackend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  actionClient.holdActions = true;
  const action = actionBackend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  await actionClient.actionStarted;
  let detached = false;
  const detach = actionBackend.closeSession("work").then((count) => {
    detached = true;
    return count;
  });
  await assert.rejects(actionBackend.inspect("work", "target-1"), /detaching/u);
  await assert.rejects(
    actionBackend.open("work", "https://example.test/late"),
    /session is detaching/u,
  );
  assert.equal(detached, false);
  assert.equal(actionClient.actionCount, 1);
  assert.equal(actionClient.calls.includes("Target.createTarget"), false);
  actionClient.releaseAction();
  await action;
  assert.equal(await detach, 1);
  assert.equal(actionClient.actionCount, 1);
  assert.deepEqual(actionClient.closedTargets, []);
});

test("closeTab fences the tab immediately and waits for its held mutation", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdActions = true;
  const action = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  await client.actionStarted;
  let detached = false;
  const closeTab = backend.closeTab("work", "target-1").then(() => {
    detached = true;
  });
  await assert.rejects(
    backend.navigate("work", "target-1", "https://example.test/late"),
    /detaching/u,
  );
  assert.equal(detached, false);
  assert.equal(client.navigateCount, 0);
  client.releaseAction();
  await action;
  await closeTab;
  assert.equal(client.actionCount, 1);
  assert.deepEqual(client.closedTargets, []);
});

test("disconnect makes action outcome unknown and concurrent observation reuse dispatches once", async () => {
  const client = new FakeUserBrowserClient();
  const backend = new UserBrowserCdpBackend(client);
  await backend.listTabs("work");
  const inspection = await backend.inspect("work", "target-1");
  const target = inspection.targets[0];
  assert.ok(target);
  client.holdActions = true;
  const first = backend.click(
    "work",
    "target-1",
    inspection.observationId,
    target.targetId,
  );
  await client.actionStarted;
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown|already in flight/u,
  );
  client.rejectAction(new Error("CDP disconnected"));
  await assert.rejects(first, /outcome is unknown/u);
  assert.equal(client.actionCount, 1);
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown/u,
  );
});

test("password and autocomplete metadata do not block ordinary text dispatch", async () => {
  for (const metadata of [
    { type: "password", autocomplete: "" },
    { type: "text", autocomplete: "current-password" },
    { type: "text", autocomplete: "new-password" },
    { type: "text", autocomplete: "one-time-code" },
  ]) {
    const client = new FakeUserBrowserClient();
    client.inspectionTarget = {
      ...client.inspectionTarget,
      ...metadata,
      secure: true,
      actions: ["type"],
    };
    const backend = new UserBrowserCdpBackend(client);
    await backend.listTabs("work");
    const inspection = await backend.inspect("work", "target-1");
    const target = inspection.targets[0];
    assert.ok(target);
    await backend.type(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
      "ordinary argument",
      false,
    );
    assert.equal(client.actionCount, 1);
  }
});

test("user browser contract accepts only supported Chrome Edge or Chromium products", () => {
  assert.equal(
    validateUserBrowserVersion({ Browser: "Chrome/140.0.7339.1" }),
    "Chrome/140.0.7339.1",
  );
  assert.equal(
    validateUserBrowserVersion({ Browser: "Edg/140.0.7339.1" }),
    "Edg/140.0.7339.1",
  );
  assert.equal(
    validateUserBrowserVersion({ Browser: "Chromium/140.0.7339.1" }),
    "Chromium/140.0.7339.1",
  );
  assert.throws(
    () => validateUserBrowserVersion({ Browser: "Firefox/141.0" }),
    /supported Chrome, Edge, or Chromium/u,
  );
  assert.throws(
    () => validateUserBrowserVersion({ Browser: "Chrome/99.0.1.2" }),
    /supported Chrome, Edge, or Chromium/u,
  );
});

test("user browser attachment rejects remote or credential-bearing CDP endpoints", async () => {
  await assert.rejects(
    connectUserBrowserCdp("https://example.test:9222"),
    /unauthenticated loopback http/u,
  );
  await assert.rejects(
    connectUserBrowserCdp("http://user:secret@127.0.0.1:9222"),
    /unauthenticated loopback http/u,
  );
});

test("user browser attachment rejects redirects and query-authenticated WebSockets", async () => {
  const redirect = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", "http://127.0.0.1:1/json/version");
    response.end();
  });
  const redirectPort = await listen(redirect);
  await assert.rejects(
    connectUserBrowserCdp(`http://127.0.0.1:${String(redirectPort)}`),
    /fetch|redirect|failed/u,
  );
  await close(redirect);

  const querySocket = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        Browser: "Chrome/140.0.1.2",
        webSocketDebuggerUrl:
          "ws://127.0.0.1:9222/devtools/browser/id?token=secret",
      }),
    );
  });
  const queryPort = await listen(querySocket);
  await assert.rejects(
    connectUserBrowserCdp(`http://127.0.0.1:${String(queryPort)}`),
    /unauthenticated loopback ws/u,
  );
  await close(querySocket);
});

test("Windows browser discovery covers machine and per-user Chrome Edge and Chromium", () => {
  const candidates = windowsBrowserExecutableCandidates({
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  });
  assert.ok(
    candidates.includes(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ),
  );
  assert.ok(
    candidates.includes(
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    ),
  );
  assert.ok(
    candidates.includes("C:\\Program Files\\Chromium\\Application\\chrome.exe"),
  );
  assert.ok(
    candidates.includes(
      "C:\\Users\\me\\AppData\\Local\\Chromium\\Application\\chrome.exe",
    ),
  );
});

class FakeUserBrowserClient implements UserBrowserCdpClient {
  actionCount = 0;
  navigateCount = 0;
  closeCount = 0;
  readonly closedTargets: string[] = [];
  readonly calls: string[] = [];
  currentUrl = "https://example.test/account";
  documentToken = "document-a";
  identityFailure?: Error;
  holdActions = false;
  holdNavigations = false;
  holdPostConfirmation = false;
  inspectionTarget = {
    selector: "#continue",
    tag: "button",
    role: "button",
    name: "Continue",
    type: "",
    id: "continue",
    fieldName: "",
    autocomplete: "",
    href: "",
    secure: false,
    actions: ["click"] as Array<"click" | "type">,
  };
  readonly #actionStarted = deferred<void>();
  #heldAction = deferred<void>();
  readonly #actionSettled = deferred<void>();
  readonly #navigationStarted = deferred<void>();
  readonly #heldNavigation = deferred<void>();
  readonly #postConfirmationStarted = deferred<void>();
  readonly #heldPostConfirmation = deferred<void>();
  readonly #postConfirmationSettled = deferred<void>();

  get actionStarted(): Promise<void> {
    return this.#actionStarted.promise;
  }

  get actionSettled(): Promise<void> {
    return this.#actionSettled.promise;
  }

  get navigationStarted(): Promise<void> {
    return this.#navigationStarted.promise;
  }

  get postConfirmationStarted(): Promise<void> {
    return this.#postConfirmationStarted.promise;
  }

  get postConfirmationSettled(): Promise<void> {
    return this.#postConfirmationSettled.promise;
  }

  advanceDocument(reason: string): void {
    this.documentToken = `${this.documentToken}:${reason}`;
  }

  releaseAction(): void {
    this.#heldAction.resolve();
  }

  releaseNavigation(): void {
    this.#heldNavigation.resolve();
  }

  releasePostConfirmation(): void {
    this.#heldPostConfirmation.resolve();
  }

  rejectAction(error: Error): void {
    this.#heldAction.reject(error);
  }

  async listTargets() {
    this.calls.push("Target.getTargets");
    if (this.holdPostConfirmation && this.actionCount > 0) {
      this.#postConfirmationStarted.resolve();
      await this.#heldPostConfirmation.promise;
      this.#postConfirmationSettled.resolve();
      this.holdPostConfirmation = false;
    }
    return [
      {
        targetId: "target-1",
        type: "page",
        title: "Account",
        url: this.currentUrl,
      },
    ];
  }

  async createTarget(_url: string) {
    this.calls.push("Target.createTarget");
    return "target-2";
  }

  async navigate(_targetId: string, _url: string) {
    this.calls.push("Page.navigate");
    this.navigateCount += 1;
    if (this.holdNavigations) {
      this.#navigationStarted.resolve();
      await this.#heldNavigation.promise;
    }
  }

  async documentIdentity(): Promise<string> {
    this.calls.push("Page.getFrameTree");
    if (this.identityFailure !== undefined) throw this.identityFailure;
    return this.documentToken;
  }

  async evaluate(
    _targetId: string,
    expression: string,
    _signal?: AbortSignal,
  ): Promise<unknown> {
    this.calls.push("Runtime.evaluate");
    if (!expression.includes("const expected =")) {
      return {
        visibleText: "Signed in as Alice",
        targets: [this.inspectionTarget],
      };
    }
    this.actionCount += 1;
    if (this.holdActions) {
      this.#actionStarted.resolve();
      try {
        await this.#heldAction.promise;
      } finally {
        this.#actionSettled.resolve();
      }
    }
    return { ok: true };
  }

  async close() {
    this.closeCount += 1;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("test server did not bind"));
      else resolve(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

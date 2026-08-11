import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  connectUserBrowserCdp,
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
  validateUserBrowserVersion,
  windowsBrowserExecutableCandidates,
} from "../src/main/capabilities/user-browser-provider.js";

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
  backend.closeTab("work", "target-1");
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
  client.documentIdentity = "document-b";
  await assert.rejects(
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /document-changed/u,
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
    backend.click(
      "work",
      "target-1",
      inspection.observationId,
      target.targetId,
    ),
    /stale or unknown/u,
  );
  client.releaseAction();
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
  closeCount = 0;
  readonly closedTargets: string[] = [];
  readonly calls: string[] = [];
  currentUrl = "https://example.test/account";
  documentIdentity = "document-a";
  holdActions = false;
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

  get actionStarted(): Promise<void> {
    return this.#actionStarted.promise;
  }

  releaseAction(): void {
    this.#heldAction.resolve();
  }

  rejectAction(error: Error): void {
    this.#heldAction.reject(error);
  }

  async listTargets() {
    this.calls.push("Target.getTargets");
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
  }

  async evaluate(
    _targetId: string,
    expression: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.calls.push("Runtime.evaluate");
    if (!expression.includes("const expected")) {
      return {
        documentIdentity: this.documentIdentity,
        inspection: {
          visibleText: "Signed in as Alice",
          targets: [this.inspectionTarget],
        },
      };
    }
    this.actionCount += 1;
    if (!expression.includes(JSON.stringify(this.documentIdentity))) {
      return { ok: false, reason: "document-changed" };
    }
    if (this.holdActions) {
      this.#actionStarted.resolve();
      await Promise.race([this.#heldAction.promise, abortPromise(signal)]);
    }
    return { ok: true };
  }

  async close() {
    this.closeCount += 1;
  }
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return;
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("cancelled", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  connectUserBrowserCdp,
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
  validateUserBrowserVersion,
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

class FakeUserBrowserClient implements UserBrowserCdpClient {
  actionCount = 0;
  closeCount = 0;
  readonly closedTargets: string[] = [];
  readonly calls: string[] = [];

  async listTargets() {
    this.calls.push("Target.getTargets");
    return [
      {
        targetId: "target-1",
        type: "page",
        title: "Account",
        url: "https://example.test/account",
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

  async evaluate(_targetId: string, expression: string): Promise<unknown> {
    this.calls.push("Runtime.evaluate");
    if (!expression.includes("const expected")) {
      return {
        visibleText: "Signed in as Alice",
        targets: [
          {
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
            actions: ["click"],
          },
        ],
      };
    }
    this.actionCount += 1;
    return { ok: true };
  }

  async close() {
    this.closeCount += 1;
  }
}

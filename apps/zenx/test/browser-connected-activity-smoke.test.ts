import assert from "node:assert/strict";
import test from "node:test";
import { smokeConnectedActivity } from "../src/main/browser-connected-activity-smoke.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";

test("CI helper creates its own Host-owned target and never borrows another session target", async () => {
  let closed = false;
  let inspected = 0;
  let detached = 0;
  const owners = new Map([["account", "windows-smoke"]]);
  const summary = (sessionId: string, tabId: string) => ({
    sessionId,
    tabId,
    title: "Fixture",
    url: "https://example.test",
    loading: false,
  });
  const backend = {
    listTabs: async (sessionId: string) =>
      [...owners]
        .filter(([, owner]) => owner === sessionId)
        .map(([tabId]) => summary(sessionId, tabId)),
    open: async (sessionId: string) => {
      assert.notEqual(sessionId, "windows-smoke");
      owners.set("new-ci-target", sessionId);
      return summary(sessionId, "new-ci-target");
    },
    inspect: async (sessionId: string, tabId: string) => {
      assert.equal(owners.get(tabId), sessionId, "provider ownership fence");
      assert.equal(tabId, "new-ci-target");
      inspected++;
      return {
        title: "Fixture",
        url: "https://example.test",
        visibleText: "Fixture",
        targets: [],
      };
    },
    closeSession: async (sessionId: string) => {
      for (const [tabId, owner] of owners)
        if (owner === sessionId) {
          owners.delete(tabId);
          detached++;
        }
      return detached;
    },
    close: async () => {
      closed = true;
    },
  } as unknown as ZenXBrowserBackend;
  await smokeConnectedActivity(backend, "https://example.test");
  assert.equal(inspected, 1);
  assert.equal(detached, 1);
  assert.deepEqual([...owners], [["account", "windows-smoke"]]);
  assert.equal(closed, false);
});

test("real provider excludes the caller-owned account from a new Host session", async () => {
  const { UserBrowserCdpBackend } =
    await import("../src/main/capabilities/user-browser-provider.js");
  const client = {
    closureProblem: () => undefined,
    listTargets: async () => [
      {
        targetId: "physical",
        type: "page",
        title: "Account",
        url: "https://example.test/account",
      },
    ],
  };
  const backend = new UserBrowserCdpBackend(client as any);
  assert.equal((await backend.listTabs("windows-smoke"))[0]?.tabId, "physical");
  assert.deepEqual(await backend.listTabs("different-host-session"), []);
  assert.equal((await backend.listTabs("windows-smoke"))[0]?.tabId, "physical");
});

test("CI helper detaches its session on inspection failure without closing caller connection", async () => {
  let owned: string | undefined;
  let detached = false;
  let closed = false;
  const backend = {
    open: async (sessionId: string) => {
      owned = sessionId;
      return {
        sessionId,
        tabId: "created",
        title: "Fixture",
        url: "https://example.test",
        loading: false,
      };
    },
    inspect: async (sessionId: string) => {
      assert.equal(sessionId, owned);
      throw new Error("inspection failed");
    },
    closeSession: async (sessionId: string) => {
      assert.equal(sessionId, owned);
      detached = true;
      return 1;
    },
    close: async () => {
      closed = true;
    },
  } as unknown as ZenXBrowserBackend;
  await assert.rejects(smokeConnectedActivity(backend, "https://example.test"));
  assert.equal(detached, true);
  assert.equal(closed, false);
});

test("CI helper records only known pre-dispatch inspection attempts; unknown never retries", async () => {
  const {
    UserBrowserDocumentChangedBeforeDispatchError,
    UserBrowserCdpOutcomeUnknownError,
  } = await import("../src/main/capabilities/user-browser-provider.js");
  for (const known of [true, false]) {
    let opens = 0,
      inspections = 0,
      detaches = 0;
    const backend = {
      open: async (sessionId: string) => {
        opens++;
        return {
          sessionId,
          tabId: "new",
          title: "Fixture",
          url: "https://example.test",
          loading: false,
        };
      },
      inspect: async () => {
        inspections++;
        if (inspections === 1)
          throw known
            ? new UserBrowserDocumentChangedBeforeDispatchError(
                "pending lifecycle",
              )
            : new UserBrowserCdpOutcomeUnknownError(
                "Runtime.evaluate",
                "timeout",
              );
        return {
          title: "Fixture",
          url: "https://example.test",
          visibleText: "Fixture",
          targets: [],
        };
      },
      closeSession: async () => {
        detaches++;
        return 1;
      },
      close: async () => {
        throw new Error("must not close caller connection");
      },
    } as unknown as ZenXBrowserBackend;
    const retryKnown = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof UserBrowserDocumentChangedBeforeDispatchError))
          throw error;
        return await operation();
      }
    };
    const run = smokeConnectedActivity(
      backend,
      "https://example.test",
      retryKnown,
    );
    if (known) await run;
    else await assert.rejects(run, UserBrowserCdpOutcomeUnknownError);
    assert.equal(opens, 1, "open is never replayed");
    assert.equal(inspections, known ? 2 : 1);
    assert.equal(detaches, 1);
  }
});

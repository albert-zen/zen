import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZenXSettingsService } from "../src/main/settings-service.js";
import {
  ZenXHostProfileStore,
  structuredLegacyModelCatalog,
} from "../src/main/host-profile.js";
import { ZenXCredentialVault } from "../src/main/credential-vault.js";

const token = (account: string) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
async function fixture(t: test.TestContext, fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ZenXHostProfileStore(path.join(directory, "profile.json"));
  await store.write({
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "opaque-profile",
        type: "openai-subscription",
        displayName: "Subscription",
        models: structuredLegacyModelCatalog("openai-subscription", [
          "gpt-5.4",
        ]),
      },
    ],
    defaultModel: { providerProfileId: "opaque-profile", modelId: "gpt-5.4" },
    titleModel: { providerProfileId: "opaque-profile", modelId: "gpt-5.4" },
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  });
  let account: string | undefined = "account-a";
  let renewals = 0,
    closes = 0;
  const auth = {
    login: async () => {
      account = "account-a";
    },
    logout: async () => {
      account = undefined;
    },
    status: async () => ({
      authenticated: account !== undefined,
      expired: false,
      accountId: account,
    }),
    acquireAccessLease: async () => ({ accessToken: token(account!) }),
    renewAccessLease: async () => {
      renewals++;
      return { accessToken: token(account!) };
    },
  };
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: path.join(directory, "zen"),
    profileStore: store,
    vault: new ZenXCredentialVault(path.join(directory, "vault"), {
      isEncryptionAvailable: () => true,
      encryptString: (v) => Buffer.from(v),
      decryptString: (v) => v.toString(),
    }),
    subscriptionFactory: () => auth,
    providerFetchFactory: () =>
      Object.assign(fetch, {
        close: async () => {
          closes++;
        },
      }),
  });
  await service.initialize({});
  return {
    service,
    setAccount: (value: string | undefined) => {
      account = value;
    },
    renewals: () => renewals,
    closes: () => closes,
  };
}
test("quota service uses configured profile and renews only one rejected access lease", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls === 1
      ? new Response(null, { status: 401 })
      : Response.json({ rate_limit: null }),
  );
  const result = await f.service.readSubscriptionUsage("opaque-profile");
  assert.equal(result.accountId, "account-a");
  assert.equal(f.renewals(), 1);
  assert.equal(f.closes(), 1);
  assert.equal(f.service.activeConfigurationOperations(), 0);
  await assert.rejects(
    f.service.readSubscriptionUsage("not-configured"),
    /quota|account/i,
  );
});
test("logout and same-account login invalidate an in-flight quota response", async (t) => {
  let resolve!: (value: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(t, async () => {
    entered();
    return await new Promise<Response>((r) => {
      resolve = r;
    });
  });
  const pending = f.service.readSubscriptionUsage("opaque-profile");
  await started;
  await f.service.logout();
  await f.service.login(
    () => {},
    () => {},
  );
  resolve(Response.json({ rate_limit: null }));
  await assert.rejects(pending, /account.*changed/i);
  assert.equal(f.closes(), 1);
  assert.equal(f.service.activeConfigurationOperations(), 0);
});
test("not signed in does not query the network", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return Response.json({});
  });
  f.setAccount(undefined);
  await assert.rejects(
    f.service.readSubscriptionUsage("opaque-profile"),
    /sign in/i,
  );
  assert.equal(calls, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readSubscriptionUsage } from "../src/main/subscription-usage.js";

const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-a" } })).toString("base64url")}.signature`;
const window = {
  used_percent: 25,
  limit_window_seconds: 18000,
  reset_at: 1800000000,
};
test("subscription usage queries the authenticated account and preserves every quota window", async () => {
  const result = await readSubscriptionUsage({
    accessToken: token,
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${token}`,
      );
      assert.equal(
        new Headers(init?.headers).get("ChatGPT-Account-Id"),
        "account-a",
      );
      return Response.json({
        account_id: "account-a",
        plan_type: "pro",
        rate_limit: { primary_window: window, secondary_window: null },
        additional_rate_limits: [
          {
            metered_feature: "other",
            limit_name: "Other models",
            rate_limit: { primary_window: { ...window, used_percent: 100 } },
          },
        ],
        code_review_rate_limit: {
          primary_window: { ...window, used_percent: 0 },
        },
      });
    },
  });
  assert.equal(result.accountId, "account-a");
  assert.equal(result.planType, "pro");
  assert.equal(result.limits.length, 3);
  assert.deepEqual(result.limits[0]?.primary, {
    usedPercent: 25,
    windowDurationSeconds: 18000,
    resetsAt: 1800000000,
  });
  assert.equal(result.limits[0]?.secondary, null);
  assert.equal(
    result.limits.find((x) => x.id === "other")?.primary?.usedPercent,
    100,
  );
});
test("missing or invalid values remain unknown instead of zero", async () => {
  const result = await readSubscriptionUsage({
    accessToken: token,
    signal: new AbortController().signal,
    fetch: async () =>
      Response.json({
        rate_limit: {
          primary_window: {
            used_percent: null,
            limit_window_seconds: "18000",
            reset_at: -1,
          },
        },
        additional_rate_limits: null,
      }),
  });
  assert.deepEqual(result.limits[0]?.primary, {
    usedPercent: null,
    windowDurationSeconds: null,
    resetsAt: null,
  });
  assert.equal(result.planType, null);
});
test("usage errors never expose response bodies or transport secrets", async () => {
  for (const fetch of [
    async () => new Response(token, { status: 401 }),
    async () => {
      throw new Error(token);
    },
    async () => new Response(token),
    async () => Response.json({ account_id: "different", rate_limit: null }),
    async () => Response.json({ unrelated: token }),
  ]) {
    await assert.rejects(
      readSubscriptionUsage({
        accessToken: token,
        signal: new AbortController().signal,
        fetch,
      }),
      (error) =>
        error instanceof Error &&
        !error.message.includes(token) &&
        /quota|account/i.test(error.message),
    );
  }
});

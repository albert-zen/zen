import assert from "node:assert/strict";
import test from "node:test";
import {
  IM_CHANNEL_SCHEMAS,
  IM_CHANNEL_SCHEMA_VERSION,
  IM_CHANNEL_SDK_REVISION,
  normalizeManagedChannel,
} from "../dist/channel-schema.js";

const SECRET = "private-form-value";
test("versioned IM provider form fields match the pinned from_config declarations", () => {
  assert.equal(IM_CHANNEL_SCHEMA_VERSION, 1);
  assert.equal(
    IM_CHANNEL_SDK_REVISION,
    "7d5f1179365679d0f95abd5cb2ce76547238d05f",
  );
  const byId = Object.fromEntries(
    IM_CHANNEL_SCHEMAS.map((schema) => [schema.id, schema]),
  );
  assert.deepEqual(
    byId.qq.fields.filter((field) => field.secret).map((field) => field.key),
    ["client_secret"],
  );
  assert.deepEqual(
    byId.telegram.fields
      .filter((field) => field.secret)
      .map((field) => field.key),
    ["bot_token"],
  );
  assert.deepEqual(
    byId.feishu.fields
      .filter((field) => field.secret)
      .map((field) => field.key),
    ["app_secret"],
  );
  assert.deepEqual(
    byId.feishu.fields.find((field) => field.key === "domain").options,
    ["feishu", "lark"],
  );
  assert.equal(byId.weixin.supported, false);
  assert.match(byId.weixin.prerequisite, /consumer-enrolled/);
  assert.deepEqual(byId.weixin.fields, []);
  assert.ok(
    IM_CHANNEL_SCHEMAS.filter((schema) => schema.supported).every((schema) =>
      schema.fields.some((field) => field.key === "access_match"),
    ),
  );
});

test("managed normalization separates write-only secrets and returns SDK-native channel fields", () => {
  const config = normalizeManagedChannel(
    "qq",
    {
      app_id: " 12345 ",
      allowed_user_ids: "u1,\nu2,u1",
      allowed_conversation_ids: "chat:1",
    },
    { client_secret: SECRET },
  );
  assert.deepEqual(config, {
    enabled: true,
    allowed_user_ids: ["u1", "u2"],
    allowed_conversation_ids: ["chat:1"],
    access_match: "any",
    app_id: "12345",
    client_secret: SECRET,
    markdown_enabled: true,
  });
  assert.deepEqual(normalizeManagedChannel("telegram", {}, {}), {
    enabled: true,
    allowed_user_ids: [],
    allowed_conversation_ids: [],
    access_match: "any",
    require_mention: true,
  });
  assert.equal(
    normalizeManagedChannel(
      "feishu",
      { app_id: "", enabled: false },
      { app_secret: "" },
    ).enabled,
    false,
  );
});

test("normalization rejects secret-in-values, unknown fields, invalid types and options without echoing content", () => {
  for (const run of [
    () => normalizeManagedChannel("qq", { client_secret: SECRET }, {}),
    () => normalizeManagedChannel("qq", { unknown: SECRET }, {}),
    () => normalizeManagedChannel("qq", {}, { app_id: SECRET }),
    () => normalizeManagedChannel("qq", { enabled: "true" }, {}),
    () => normalizeManagedChannel("feishu", { domain: SECRET }, {}),
    () => normalizeManagedChannel("qq", {}, { client_secret: true }),
    () => normalizeManagedChannel("weixin", {}, {}),
  ])
    assert.throws(run, (error) => !error.message.includes(SECRET));
});

test("managed access normalization rejects wildcard mixtures and malformed deny-all policy", () => {
  assert.throws(
    () => normalizeManagedChannel("qq", { allowed_user_ids: "*,trusted" }, {}),
    /wildcard/,
  );
  assert.throws(
    () =>
      normalizeManagedChannel(
        "qq",
        { allowed_user_ids: "none", allowed_conversation_ids: "trusted" },
        {},
      ),
    /deny-all/,
  );
  assert.deepEqual(
    normalizeManagedChannel("qq", { allowed_user_ids: "none" }, {})
      .allowed_user_ids,
    ["none"],
  );
  const config = normalizeManagedChannel(
    "qq",
    {
      allowed_user_ids: "*",
      allowed_conversation_ids: "chat:1",
      access_match: "any",
    },
    {},
  );
  assert.deepEqual(config.allowed_user_ids, ["*"]);
  assert.deepEqual(config.allowed_conversation_ids, ["chat:1"]);
});

test("malformed nonempty QQ IDs, oversized fields and NUL characters are rejected while incomplete saves are allowed", () => {
  assert.throws(
    () => normalizeManagedChannel("qq", { app_id: "not-decimal" }, {}),
    /decimal/,
  );
  assert.throws(
    () => normalizeManagedChannel("qq", { app_id: "1".repeat(4097) }, {}),
    /length/,
  );
  assert.throws(
    () =>
      normalizeManagedChannel("qq", {}, { client_secret: "x".repeat(8193) }),
    /length/,
  );
  assert.throws(
    () => normalizeManagedChannel("telegram", {}, { bot_token: "has\0nul" }),
    /invalid character/,
  );
  assert.equal(normalizeManagedChannel("qq", { app_id: "" }, {}).app_id, "");
});

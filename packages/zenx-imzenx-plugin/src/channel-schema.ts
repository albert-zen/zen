/** IMZenX-owned form declarations verified against the pinned provider source.
 * SDK 7d5f1179365679d0f95abd5cb2ce76547238d05f exposes from_config methods,
 * not a field-descriptor API: imagent/channels/native/{qq,telegram,feishu}.py
 * and common access.py. This is a bounded IM configuration schema, not a new
 * plugin permission, credential store or channel runtime.
 */
export type ImZenXChannelId = "qq" | "telegram" | "feishu" | "weixin";
export interface ImChannelField {
  key: string;
  label: string;
  type: "string" | "boolean";
  secret: boolean;
  required: boolean;
  defaultValue?: string | boolean;
  options?: readonly string[];
}
export interface ImChannelSchema {
  id: ImZenXChannelId;
  label: string;
  supported: boolean;
  prerequisite?: string;
  fields: readonly ImChannelField[];
}
export const IM_CHANNEL_SCHEMA_VERSION = 1;
export const IM_CHANNEL_SDK_REVISION =
  "7d5f1179365679d0f95abd5cb2ce76547238d05f";
const common: readonly ImChannelField[] = [
  {
    key: "enabled",
    label: "Enable channel",
    type: "boolean",
    secret: false,
    required: false,
    defaultValue: true,
  },
  {
    key: "allowed_user_ids",
    label: "Allowed user IDs",
    type: "string",
    secret: false,
    required: false,
  },
  {
    key: "allowed_conversation_ids",
    label: "Allowed conversation IDs",
    type: "string",
    secret: false,
    required: false,
  },
  {
    key: "access_match",
    label: "Access match",
    type: "string",
    secret: false,
    required: false,
    defaultValue: "any",
    options: ["any", "all"],
  },
];
export const IM_CHANNEL_SCHEMAS: readonly ImChannelSchema[] = [
  {
    id: "qq",
    label: "QQ",
    supported: true,
    fields: [
      ...common,
      {
        key: "app_id",
        label: "App ID",
        type: "string",
        secret: false,
        required: true,
      },
      {
        key: "client_secret",
        label: "App secret",
        type: "string",
        secret: true,
        required: true,
      },
      {
        key: "markdown_enabled",
        label: "Markdown replies",
        type: "boolean",
        secret: false,
        required: false,
        defaultValue: true,
      },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    supported: true,
    fields: [
      ...common,
      {
        key: "bot_token",
        label: "Bot token",
        type: "string",
        secret: true,
        required: true,
      },
      {
        key: "require_mention",
        label: "Require mention",
        type: "boolean",
        secret: false,
        required: false,
        defaultValue: true,
      },
    ],
  },
  {
    id: "feishu",
    label: "Feishu / Lark",
    supported: true,
    fields: [
      ...common,
      {
        key: "app_id",
        label: "App ID",
        type: "string",
        secret: false,
        required: true,
      },
      {
        key: "app_secret",
        label: "App secret",
        type: "string",
        secret: true,
        required: true,
      },
      {
        key: "domain",
        label: "Platform",
        type: "string",
        secret: false,
        required: false,
        defaultValue: "feishu",
        options: ["feishu", "lark"],
      },
      {
        key: "require_mention",
        label: "Require mention",
        type: "boolean",
        secret: false,
        required: false,
        defaultValue: true,
      },
    ],
  },
  {
    id: "weixin",
    label: "Weixin",
    supported: false,
    prerequisite:
      "Weixin requires this deployment's SDK consumer-enrolled private state directory. Select your own existing IMZen configuration in advanced settings; the simple form does not create enrollment credentials.",
    fields: [],
  },
];

/** Called only by the native write-only Host save path, never an Agent tool. */
export function normalizeManagedChannel(
  channelId: string,
  values: Record<string, string | boolean>,
  secrets: Record<string, string | undefined>,
): Record<string, unknown> {
  const schema = IM_CHANNEL_SCHEMAS.find(
    (candidate) => candidate.id === channelId,
  );
  if (schema === undefined || !schema.supported)
    throw new Error(
      "This channel requires its own explicitly prepared IMZen deployment configuration",
    );
  if (
    typeof values !== "object" ||
    values === null ||
    Array.isArray(values) ||
    typeof secrets !== "object" ||
    secrets === null ||
    Array.isArray(secrets)
  )
    throw new Error("Invalid IM channel form");
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  if (
    Object.keys(values).some(
      (key) => !fields.has(key) || fields.get(key)!.secret,
    )
  )
    throw new Error("IM channel values contain an unsupported or secret field");
  if (
    Object.keys(secrets).some(
      (key) => !fields.has(key) || !fields.get(key)!.secret,
    )
  )
    throw new Error("IM channel secrets contain an unsupported field");
  const result: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const raw = field.secret ? secrets[field.key] : values[field.key];
    if (raw !== undefined && typeof raw !== field.type)
      throw new Error("Invalid IM channel field type");
    if (
      typeof raw === "string" &&
      (raw.includes("\0") || raw.length > (field.secret ? 8192 : 4096))
    )
      throw new Error(
        "IM channel field exceeds its supported length or contains an invalid character",
      );
    if (field.secret) {
      // Blank write-only inputs preserve an existing credential at the Host.
      if (typeof raw === "string" && raw.trim()) result[field.key] = raw.trim();
      continue;
    }
    const value =
      typeof raw === "string" ? raw.trim() : (raw ?? field.defaultValue);
    if (
      field.options !== undefined &&
      value !== undefined &&
      !field.options.includes(String(value))
    )
      throw new Error("Invalid IM channel option");
    if (
      field.key === "allowed_user_ids" ||
      field.key === "allowed_conversation_ids"
    ) {
      result[field.key] =
        typeof value === "string"
          ? [
              ...new Set(
                value
                  .replaceAll("\n", ",")
                  .split(",")
                  .map((id) => id.trim())
                  .filter(Boolean),
              ),
            ]
          : [];
    } else if (value !== undefined) result[field.key] = value;
  }
  if (
    channelId === "qq" &&
    typeof result["app_id"] === "string" &&
    result["app_id"] !== "" &&
    !/^[0-9]+$/.test(result["app_id"])
  )
    throw new Error("QQ App ID must contain decimal digits");
  const access = [
    ...(result["allowed_user_ids"] as string[]),
    ...(result["allowed_conversation_ids"] as string[]),
  ];
  for (const key of ["allowed_user_ids", "allowed_conversation_ids"]) {
    const ids = result[key] as string[];
    if (ids.includes("*") && ids.some((id) => id !== "*"))
      throw new Error(
        "A wildcard cannot be combined with restricted IDs in one access field",
      );
  }
  if (access.includes("none") && access.some((id) => id !== "none"))
    throw new Error(
      "The deny-all value cannot be combined with other access IDs",
    );
  // Saving an incomplete form is allowed; safe inspection marks missing
  // required credentials instead of exposing values or starting the channel.
  return result;
}

export interface ManagedChannelInspection {
  channels: readonly {
    id: ImZenXChannelId;
    enabled: boolean;
    credentialsConfigured: boolean;
    accessRestricted: boolean;
  }[];
}

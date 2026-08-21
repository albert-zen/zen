import type { ProviderSelection } from "../../provider-registry.js";

const PREFIX = "zen-model-v1:";

export interface WireModelIdentity {
  providerProfileId: string;
  modelId: string;
}

export function encodeModelKey(
  selection: Pick<ProviderSelection, "providerProfileId" | "modelId">,
): string {
  const payload = JSON.stringify([
    selection.providerProfileId,
    selection.modelId,
  ]);
  return `${PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function decodeModelKey(key: string): WireModelIdentity {
  if (!key.startsWith(PREFIX)) {
    throw new Error("Malformed Zen opaque model key");
  }
  const encoded = key.slice(PREFIX.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("Malformed Zen opaque model key");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed Zen opaque model key");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error("Malformed Zen opaque model key");
  }
  const identity = {
    providerProfileId: parsed[0] as string,
    modelId: parsed[1] as string,
  };
  if (encodeModelKey(identity) !== key) {
    throw new Error("Malformed Zen opaque model key");
  }
  return identity;
}

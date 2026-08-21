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
  return `${PREFIX}${encodeBase64Url(payload)}`;
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
    parsed = JSON.parse(decodeBase64Url(encoded));
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

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(
    standard.length + ((4 - (standard.length % 4)) % 4),
    "=",
  );
  const binary = globalThis.atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

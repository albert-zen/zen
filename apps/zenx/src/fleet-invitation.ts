/** A short-lived bearer secret for a human to copy, never a model tool result. */
export interface FleetInvitation {
  version: 1;
  hostId: string;
  endpoint: string;
  label: string;
  expiresAt: number;
  access: "read" | "control";
  shellEnabled: boolean;
  code: string;
}

/** The exact displayed sharing scope acknowledged by the human issuer. */
export interface FleetInvitationConsent {
  revision: number;
  hostId: string;
  access: "read" | "control";
  shellEnabled: boolean;
  relayEndpoint: string | null;
}
export type FleetInvitationHostConsent = Omit<
  FleetInvitationConsent,
  "revision"
>;

export function parseFleetInvitationHostConsent(
  value: unknown,
): FleetInvitationHostConsent {
  const allowed = ["hostId", "access", "shellEnabled", "relayEndpoint"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(
      "Invalid Fleet invitation scope; refresh settings and review sharing again",
    );
  const input = value as Record<string, unknown>;
  if (
    !text(input.hostId, 128) ||
    (input.access !== "read" && input.access !== "control") ||
    typeof input.shellEnabled !== "boolean" ||
    (input.shellEnabled && input.access !== "control") ||
    (input.relayEndpoint !== null && typeof input.relayEndpoint !== "string")
  )
    throw new Error(
      "Invalid Fleet invitation scope; refresh settings and review sharing again",
    );
  let relayEndpoint: string | null;
  try {
    relayEndpoint =
      input.relayEndpoint === null
        ? null
        : normalizeFleetInvitationEndpoint(input.relayEndpoint);
  } catch {
    throw new Error(
      "Invalid Fleet invitation scope; refresh settings and review sharing again",
    );
  }
  return {
    hostId: input.hostId,
    access: input.access,
    shellEnabled: input.shellEnabled,
    relayEndpoint,
  };
}
export function parseFleetInvitationConsent(
  value: unknown,
): FleetInvitationConsent {
  const allowed = [
    "revision",
    "hostId",
    "access",
    "shellEnabled",
    "relayEndpoint",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(
      "Invalid Fleet invitation scope; refresh settings and review sharing again",
    );
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0)
    throw new Error(
      "Invalid Fleet invitation scope; refresh settings and review sharing again",
    );
  return {
    revision: input.revision as number,
    ...parseFleetInvitationHostConsent({
      hostId: input.hostId,
      access: input.access,
      shellEnabled: input.shellEnabled,
      relayEndpoint: input.relayEndpoint,
    }),
  };
}

/** Explicit public facts, deliberately independent of saved credentials/config. */
export interface FleetReadiness {
  source: "zenx.fleet";
  revision: number;
  host: {
    configured: boolean;
    enabled: boolean;
    hostId: string | null;
    access: "read" | "control";
    shellEnabled: boolean;
    url?: string;
    originEndpoint?: string;
    relayEndpoint?: string;
    relayConnected: boolean;
    relayConfigured: boolean;
    error?: string;
  };
  devices: Array<{
    id: string;
    label: string;
    description?: string;
    key?: string;
    transport: "local" | "ssh" | "https";
    access: "read" | "control";
    shellEnabled?: boolean;
    status: "local" | "not_checked";
    check: {
      state: "not_checked" | "checking" | "reachable" | "failed";
      live: false;
      checkedAt?: number;
      detail?: string;
    };
  }>;
  prerequisites: {
    credentialEncryption: boolean;
    tlsConfigured: boolean;
    hostEnabled: boolean;
    trustedEndpointConfigured: boolean;
    relayCredentialConfigured: boolean;
  };
  limits: string[];
}

const PREFIX = "zenx-fleet:v1:";
const MAX_VALUE_LENGTH = 8192;
export const FLEET_INVITATION_LIFETIME_MS = 5 * 60_000;
const keys = [
  "version",
  "hostId",
  "endpoint",
  "label",
  "expiresAt",
  "access",
  "shellEnabled",
  "code",
];
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\x00-\x1f\x7f]/u.test(value)
  );
}
/** Portable authority validation shared by the human issuer and preview. */
export function normalizeFleetInvitationEndpoint(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\%@]/u.test(value) ||
    !/^https:\/\/[^/?#]+\/?$/u.test(value)
  )
    throw new Error("Invalid Fleet invitation endpoint; use one HTTPS origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Fleet invitation endpoint; use one HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port === "0"
  )
    throw new Error("Invalid Fleet invitation endpoint; use one HTTPS origin");
  return url.origin;
}
function validate(value: unknown, now: number): FleetInvitation {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid Fleet invitation");
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !text(input.hostId, 128) ||
    !text(input.label, 120) ||
    typeof input.code !== "string" ||
    !/^[a-zA-Z0-9_-]{16,256}$/u.test(input.code) ||
    (input.access !== "read" && input.access !== "control") ||
    typeof input.shellEnabled !== "boolean" ||
    (input.shellEnabled && input.access !== "control")
  )
    throw new Error("Invalid Fleet invitation");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.expiresAt as number) > now + FLEET_INVITATION_LIFETIME_MS
  )
    throw new Error("Invalid Fleet invitation expiry");
  if ((input.expiresAt as number) <= now)
    throw new Error("Fleet invitation expired; request a fresh invitation");
  return {
    version: 1,
    hostId: input.hostId,
    endpoint: normalizeFleetInvitationEndpoint(input.endpoint),
    label: input.label,
    expiresAt: input.expiresAt as number,
    access: input.access,
    shellEnabled: input.shellEnabled,
    code: input.code,
  };
}
function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
/** Opaque encoding is for pasting, not encryption or evidence of Host trust. */
export function encodeFleetInvitation(invitation: FleetInvitation): string {
  const value = validate(invitation, Date.now());
  return PREFIX + encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}
/** `now` is an injected clock for deterministic callers; expiry is mandatory. */
export function parseFleetInvitation(
  value: string,
  now: number = Date.now(),
): FleetInvitation {
  if (
    typeof value !== "string" ||
    value.length > MAX_VALUE_LENGTH ||
    !value.startsWith(PREFIX)
  )
    throw new Error("Invalid Fleet invitation");
  const encoded = value.slice(PREFIX.length);
  if (!/^[a-zA-Z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid Fleet invitation");
  let input: unknown;
  try {
    const bytes = Uint8Array.from(
      atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/")),
      (character) => character.charCodeAt(0),
    );
    if (encodeBytes(bytes) !== encoded)
      throw new Error("Noncanonical encoding");
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Never forward parser errors: they may contain the input bearer secret.
    throw new Error("Invalid Fleet invitation");
  }
  return validate(input, now);
}

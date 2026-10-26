import type {
  ModelRequest,
  ModelRequestObservation,
  ToolMediaTransportSummary,
} from "../model.js";

const credentialField =
  /^(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)$/iu;

/** Redact credentials before any size limit. No transport metadata enters the observer. */
export function observeRequestBody(
  request: ModelRequest,
  body: string,
  format: ModelRequestObservation["format"],
  provider: string,
  transportAttempt: number,
  secrets: readonly string[] = [],
  toolMediaTransport?: ToolMediaTransportSummary,
): void {
  if (request.onRequest === undefined) return;
  try {
    let redacted = false;
    const scrub = (text: string): string => {
      for (const secret of secrets) {
        if (secret.length > 0 && text.includes(secret)) {
          text = text.split(secret).join("[redacted]");
          redacted = true;
        }
      }
      return text;
    };
    const visit = (value: unknown): unknown => {
      if (typeof value === "string") return scrub(value);
      if (Array.isArray(value)) return value.map(visit);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => {
            if (credentialField.test(key)) {
              redacted = true;
              return [scrub(key), "[redacted]"];
            }
            return [scrub(key), visit(entry)];
          }),
        );
      }
      return value;
    };
    const value = visit(JSON.parse(body));
    const safeProvider = scrub(provider);
    const safeModel = scrub(request.model);
    request.onRequest({
      format,
      ...(toolMediaTransport === undefined
        ? {}
        : {
            toolMediaTransport:
              sanitizeToolMediaTransportSummary(toolMediaTransport),
          }),
      body: redacted ? JSON.stringify(value) : body,
      originalBytes: Buffer.byteLength(body, "utf8"),
      redacted,
      transportAttempt,
      provider: safeProvider,
      model: safeModel,
    });
  } catch {
    // Debugging is observational: it cannot fail, retry or alter a sample.
  }
}

/** Explicit allowlist prevents accidental transport metadata from reaching capture. */
export function sanitizeToolMediaTransportSummary(
  value: ToolMediaTransportSummary,
): ToolMediaTransportSummary {
  const count = (n: number) =>
    Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 1_000_000) : 0;
  return {
    nativeToolContent: count(value.nativeToolContent),
    compatibilitySupplement: count(value.compatibilitySupplement),
    unknownTarget: count(value.unknownTarget),
    undeclaredMedia: count(value.undeclaredMedia),
    nativeSupportUnverified: count(value.nativeSupportUnverified),
    conflictingEvidence: count(value.conflictingEvidence),
  };
}

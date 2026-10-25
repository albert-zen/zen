import type { SerializedMessageSource } from "./message-provenance.js";
import type { ModelRequest, ModelRequestObservation } from "../model.js";

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
  messageSources: readonly SerializedMessageSource[] = [],
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
      body: redacted ? JSON.stringify(value) : body,
      originalBytes: Buffer.byteLength(body, "utf8"),
      redacted,
      transportAttempt,
      messageSources:
        messageSources.length > 1024
          ? []
          : messageSources.map((source) => ({
              ...source,
              itemId: scrub(source.itemId),
            })),
      provider: safeProvider,
      model: safeModel,
    });
  } catch {
    // Debugging is observational: it cannot fail, retry or alter a sample.
  }
}

/** Display context only: never an identity, authorization, or client clock claim. */
export interface ReceiptTimezone {
  timeZone: string;
  source: "client" | "host" | "utc-fallback";
}

const normalizedTimeZones = new Map<string, string>();
let normalizationConstructor: typeof Intl.DateTimeFormat | undefined;
const MAX_NORMALIZED_TIME_ZONES = 256;

/** Accept bounded Intl-supported IANA names, never arbitrary model-facing text. */
export function normalizeTimeZone(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/u.test(value)
  )
    return undefined;
  try {
    const constructor = Intl.DateTimeFormat;
    if (normalizationConstructor !== constructor) {
      normalizedTimeZones.clear();
      normalizationConstructor = constructor;
    }
    const known = normalizedTimeZones.get(value);
    if (known !== undefined) return known;
    const normalized = new constructor("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
    if (normalizedTimeZones.size >= MAX_NORMALIZED_TIME_ZONES)
      normalizedTimeZones.delete(normalizedTimeZones.keys().next().value!);
    normalizedTimeZones.set(value, normalized);
    return normalized;
  } catch {
    return undefined;
  }
}

/** Capture only at new human admission, not when replaying stored history. */
export function captureReceiptTimezone(
  clientTimezone?: string,
): ReceiptTimezone {
  const client = normalizeTimeZone(clientTimezone);
  if (client !== undefined) return { timeZone: client, source: "client" };
  try {
    const host = normalizeTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (host !== undefined) return { timeZone: host, source: "host" };
  } catch {
    /* A missing Intl/OS timezone has an explicitly labelled UTC fallback. */
  }
  return { timeZone: "UTC", source: "utc-fallback" };
}

/** The recorded instant determines DST/offset; never consult today's clock. */
export function formatReceiptTimestamp(
  timestamp: string,
  zone?: ReceiptTimezone,
): string {
  if (zone === undefined) return timestamp; // Legacy facts retain their exact representation.
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;
  const rawOffset = part("timeZoneName");
  const offset = rawOffset === "GMT" ? "+00:00" : rawOffset.replace("GMT", "");
  const local = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${date.toISOString().slice(20, 23)}${offset}`;
  const source =
    zone.source === "client"
      ? "Client-reported timezone"
      : zone.source === "host"
        ? "Host timezone"
        : "UTC fallback timezone";
  return `${local}; ${source}: ${zone.timeZone} (UTC${offset})${zone.source === "client" ? "" : "; client timezone unavailable"}`;
}

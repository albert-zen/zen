/** UI-reported activation evidence. Not a trusted actor or synchronized Host clock. */
export interface ClientSendObservation {
  requestId: string;
  action: "send" | "retry";
  clock: { domain: string; monotonicNs: string; wallTime: string };
}
/** Malformed optional telemetry is ignored, never changes input admission. */
export function parseClientSendObservation(
  value: unknown,
): ClientSendObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const clock = input.clock as Record<string, unknown> | undefined;
  if (
    typeof input.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(input.requestId) ||
    (input.action !== "send" && input.action !== "retry") ||
    !clock ||
    typeof clock !== "object" ||
    Array.isArray(clock) ||
    typeof clock.domain !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(clock.domain) ||
    typeof clock.monotonicNs !== "string" ||
    !/^\d{1,24}$/u.test(clock.monotonicNs) ||
    typeof clock.wallTime !== "string" ||
    clock.wallTime.length > 40 ||
    !Number.isFinite(Date.parse(clock.wallTime))
  )
    return;
  return {
    requestId: input.requestId,
    action: input.action,
    clock: {
      domain: clock.domain,
      monotonicNs: clock.monotonicNs,
      wallTime: clock.wallTime,
    },
  };
}

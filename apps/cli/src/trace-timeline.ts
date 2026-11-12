import type { TraceClock, TraceRecord } from "../../../src/trace.js";
import { parseClientSendObservation } from "../../../src/client-observation.js";
import type {
  TraceTimeline,
  TraceTimelinePoint,
} from "./model-request-debug-types.js";
const facts = (r?: TraceRecord): Record<string, unknown> =>
  r?.data && typeof r.data === "object" && !Array.isArray(r.data)
    ? (r.data as Record<string, unknown>)
    : {};
function clock(value: unknown): TraceClock | undefined {
  if (!value || typeof value !== "object") return;
  const c = value as TraceClock;
  if (
    typeof c.domain === "string" &&
    typeof c.monotonicNs === "string" &&
    /^\d+$/u.test(c.monotonicNs) &&
    typeof c.wallTime === "string"
  )
    return c;
}
export function observedTraceClock(r?: TraceRecord): TraceClock | undefined {
  return clock(facts(r).observedClock) ?? r?.clock;
}
export function clockElapsed(
  from?: TraceClock,
  to?: TraceClock,
): number | null {
  if (!from || !to || from.domain !== to.domain) return null;
  try {
    const ns = BigInt(to.monotonicNs) - BigInt(from.monotonicNs);
    return ns < 0n ? null : Number(ns) / 1e6;
  } catch {
    return null;
  }
}
/** Disposable associations from exact sample/client IDs, not a causal or execution ledger. */
export function relatedTimelineRecords(
  selected: TraceRecord,
  records: readonly TraceRecord[],
): TraceRecord[] {
  const sameThread = records.filter((r) => r.threadId === selected.threadId);
  const sample =
    selected.sampleId === undefined
      ? [selected]
      : sameThread.filter((r) => r.sampleId === selected.sampleId);
  const ids = new Set(
    sample.flatMap((r) =>
      Array.isArray(facts(r).clientIds)
        ? (facts(r).clientIds as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [],
    ),
  );
  const requestIds = new Set(
    sample.flatMap((r) =>
      typeof facts(r).requestId === "string"
        ? [facts(r).requestId as string]
        : [],
    ),
  );
  const activationIds = new Set(
    sample.flatMap((r) => {
      const c = parseClientSendObservation(facts(r).clientObservation);
      return c ? [c.requestId] : [];
    }),
  );
  const ingress = sameThread.filter(
    (r) =>
      r.type === "client_request_received" &&
      (ids.has(String(facts(r).clientId)) ||
        requestIds.has(String(facts(r).requestId)) ||
        activationIds.has(
          parseClientSendObservation(facts(r).clientObservation)?.requestId ??
            "",
        )),
  );
  for (const r of ingress) {
    requestIds.add(String(facts(r).requestId));
    const c = parseClientSendObservation(facts(r).clientObservation);
    if (c) activationIds.add(c.requestId);
  }
  const included = new Set([...sample, ...ingress].map((r) => r.id));
  return sameThread.filter(
    (r) =>
      included.has(r.id) ||
      (r.type === "client_request_finished" &&
        requestIds.has(String(facts(r).requestId))) ||
      (r.type === "client_send_activated" &&
        activationIds.has(
          parseClientSendObservation(facts(r).clientObservation)?.requestId ??
            "",
        )),
  );
}
export function buildTraceTimeline(
  selected: TraceRecord,
  related: readonly TraceRecord[],
): TraceTimeline {
  const sample =
    selected.sampleId === undefined
      ? []
      : related.filter((r) => r.sampleId === selected.sampleId);
  const attempt = facts(selected).transportAttempt;
  const transport =
    typeof attempt !== "number"
      ? []
      : sample.filter((r) => facts(r).transportAttempt === attempt);
  const find = (type: string) => sample.find((r) => r.type === type);
  const findTransport = (type: string) =>
    transport.find((r) => r.type === type);
  const stages: TraceTimelinePoint[] = [];
  const add = (
    stage: string,
    record?: TraceRecord,
    from?: TraceRecord,
    fromStage?: string,
  ) =>
    stages.push({
      stage,
      clock: observedTraceClock(record) ?? null,
      recordId: record?.id ?? null,
      elapsedMs: clockElapsed(
        observedTraceClock(from),
        observedTraceClock(record),
      ),
      elapsedFrom: fromStage ?? null,
      outcome:
        typeof facts(record).outcome === "string"
          ? (facts(record).outcome as string)
          : null,
    });
  for (const stage of [
    "context_preparation",
    "context_materialize",
    "context_compile",
  ]) {
    const start = find(`${stage}_started`);
    const end = sample.find(
      (r) =>
        r.type === `${stage}_finished` &&
        facts(r).spanId === facts(start).spanId,
    );
    add(`${stage}_started`, start);
    add(`${stage}_finished`, end, start, `${stage}_started`);
  }
  add("model_sample_started", find("model_sample_started"));
  add("request_prepared", findTransport("model_request"));
  const dispatched = findTransport("model_request_dispatched");
  add("fetch_invoked", dispatched);
  add(
    "response_headers",
    findTransport("model_response_headers"),
    dispatched,
    "fetch_invoked",
  );
  add(
    "first_response_bytes",
    transport.find(
      (r) =>
        r.type === "model_response_chunk" &&
        r.artifacts.some(
          (a) => a.name === "response_body" && a.ref.byteLength > 0,
        ),
    ),
    dispatched,
    "fetch_invoked",
  );
  for (const [stage, field] of [
    ["first_exposed_reasoning", "exposedReasoning"],
    ["first_exposed_summary", "exposedSummary"],
    ["first_exposed_text", "exposedText"],
  ] as const)
    add(
      stage,
      transport.find(
        (r) => r.type === "model_event" && facts(r)[field] === true,
      ),
      dispatched,
      "fetch_invoked",
    );
  add(
    "model_sample_finished",
    find("model_sample_finished"),
    find("model_sample_started"),
    "model_sample_started",
  );
  add(
    "raw_eof",
    transport.find(
      (r) =>
        r.type === "model_response_end" && facts(r).completeness === "complete",
    ),
    dispatched,
    "fetch_invoked",
  );
  const received = related.filter((r) => r.type === "client_request_received");
  const inputs: TraceTimeline["inputs"] = received.map((r) => {
    const f = facts(r),
      c = parseClientSendObservation(f.clientObservation);
    const finish = related.find(
      (x) =>
        x.type === "client_request_finished" &&
        facts(x).requestId === f.requestId,
    );
    const result = facts(finish).result as Record<string, unknown> | undefined;
    const admission = result?.admission as Record<string, unknown> | undefined;
    return {
      requestId: String(f.requestId),
      clientId: typeof f.clientId === "string" ? f.clientId : null,
      activation: c?.clock ?? null,
      received: clock(f.hostReceived) ?? r.clock,
      outcome:
        typeof result?.status === "string"
          ? result.status
          : Array.isArray(result?.results) && result.results.length > 0
            ? [
                ...new Set(
                  result.results.flatMap((value) =>
                    value &&
                    typeof value === "object" &&
                    typeof value.status === "string"
                      ? [value.status]
                      : [],
                  ),
                ),
              ].join(", ") || String(facts(finish).outcome ?? "unknown")
            : admission?.state === "queued"
              ? "queued"
              : String(facts(finish).outcome ?? "unknown"),
    };
  });
  // A click that never reached admission remains an observation, not a failed sample.
  for (const r of related.filter((r) => r.type === "client_send_activated")) {
    const c = parseClientSendObservation(facts(r).clientObservation);
    if (
      c &&
      !received.some(
        (x) =>
          parseClientSendObservation(facts(x).clientObservation)?.requestId ===
          c.requestId,
      )
    )
      inputs.push({
        requestId: c.requestId,
        clientId: null,
        activation: c.clock,
        received: null,
        outcome: "unknown",
      });
  }
  return { inputs, stages };
}

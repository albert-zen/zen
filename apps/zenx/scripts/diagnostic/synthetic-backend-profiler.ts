import { Session } from "node:inspector";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { DomainThreadJournal } from "../../../../src/domain-journal.js";
import { FileItemListStore } from "../../../../src/item-list-store.js";
import { FileTraceStore } from "../../../../src/trace.js";

// Diagnostic checkout only; never install this module in a product release.
type Counter = { started: number; completed: number; errors: number; wallMs: number };
type State = {
  id: string;
  start: number;
  cpu: NodeJS.CpuUsage;
  utilization: ReturnType<typeof performance.eventLoopUtilization>;
  delay: ReturnType<typeof monitorEventLoopDelay>;
  counters: Map<string, Counter>;
  spans: Array<{ phase: string; startMs: number; durationMs: number; failed: boolean }>;
  droppedSpans: number;
};
export function installSyntheticBackendProfiler(): void {
  if (process.env.ZENX_SYNTHETIC_BACKEND_PROFILE !== "1") return;
  let current: State | undefined;
  let session: Session | undefined;
  let control: Promise<void> = Promise.resolve();
  const post = (active: Session, method: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      active.post(method, (error, result) => {
        if (error) reject(error);
        else resolve((result ?? {}) as Record<string, unknown>);
      });
    });
  const instrument = (prototype: object, method: string, phase: string) => {
    const target = prototype as Record<string, (...args: unknown[]) => unknown>;
    const original = target[method];
    if (typeof original !== "function") throw new Error("Missing profile phase " + phase);
    target[method] = function (this: unknown, ...args: unknown[]): unknown {
      const state = current;
      if (state === undefined) return Reflect.apply(original, this, args);
      const start = performance.now();
      const counter = state.counters.get(phase) ?? { started: 0, completed: 0, errors: 0, wallMs: 0 };
      state.counters.set(phase, counter);
      counter.started++;
      const finish = (failed: boolean) => {
        const durationMs = performance.now() - start;
        counter.completed++;
        counter.errors += Number(failed);
        counter.wallMs += durationMs;
        if (state.spans.length < 512)
          state.spans.push({ phase, startMs: start - state.start, durationMs, failed });
        else state.droppedSpans++;
      };
      try {
        return Promise.resolve(Reflect.apply(original, this, args)).then(
          (value) => { finish(false); return value; },
          (error: unknown) => { finish(true); throw error; },
        );
      } catch (error) {
        finish(true);
        throw error;
      }
    };
  };
  instrument(DomainThreadJournal.prototype, "assertRecoverySafe", "domain.assertRecoverySafe");
  instrument(DomainThreadJournal.prototype, "append", "domain.append");
  instrument(DomainThreadJournal.prototype, "reconcileCompilation", "domain.reconcileCompilation.public");
  instrument(FileTraceStore.prototype, "read", "trace.read");
  instrument(FileItemListStore.prototype, "exists", "semantic.exists");
  instrument(FileItemListStore.prototype, "read", "semantic.read");
  instrument(FileItemListStore.prototype, "append", "semantic.append");
  process.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    const request = message as { type?: unknown; operation?: unknown; id?: unknown };
    if (request.type !== "zenx-synthetic-backend-profile") return;
    if ((request.operation !== "start" && request.operation !== "stop") || typeof request.id !== "string") return;
    if (request.id !== process.env.ZENX_SYNTHETIC_BACKEND_PROFILE_NONCE) return;
    const operation = request.operation;
    const id = request.id;
    const execute = async () => {
      try {
        if (operation === "start") {
          if (current !== undefined || session !== undefined) throw new Error("Profile already active");
          const active = new Session();
          active.connect();
          session = active;
          await post(active, "Profiler.enable");
          await post(active, "Profiler.start");
          const delay = monitorEventLoopDelay({ resolution: 10 });
          delay.enable();
          current = {
            id, start: performance.now(), cpu: process.cpuUsage(),
            utilization: performance.eventLoopUtilization(), delay,
            counters: new Map(), spans: [], droppedSpans: 0,
          };
          process.send?.({ type: "zenx-synthetic-backend-profile-result", operation, id, ok: true });
          return;
        }
        const state = current;
        const active = session;
        if (state === undefined || active === undefined || state.id !== id) throw new Error("No matching active profile");
        current = undefined;
        const wallMs = performance.now() - state.start;
        const cpu = process.cpuUsage(state.cpu);
        const utilization = performance.eventLoopUtilization(state.utilization);
        state.delay.disable();
        const counters = Object.fromEntries([...state.counters].map(([phase, value]) => [phase, { ...value, inFlight: value.started - value.completed }]));
        const spans = [...state.spans];
        const profile = await post(active, "Profiler.stop");
        const captured = profile.profile as { samples?: unknown; timeDeltas?: unknown };
        const samples = captured?.samples;
        const deltas = captured?.timeDeltas;
        const weightedValid = Array.isArray(samples) && Array.isArray(deltas) &&
          samples.length === deltas.length &&
          deltas.every((value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0);
        await post(active, "Profiler.disable");
        active.disconnect();
        session = undefined;
        process.send?.({
          type: "zenx-synthetic-backend-profile-result", operation, id, ok: true,
          result: {
            diagnosticOnly: true, pid: process.pid, wallMs,
            cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
            eventLoopUtilization: utilization,
            eventLoopDelayMs: {
              mean: state.delay.mean / 1e6, max: state.delay.max / 1e6,
              p50: state.delay.percentile(50) / 1e6, p99: state.delay.percentile(99) / 1e6,
            },
            counters, spans, droppedSpans: state.droppedSpans,
            note: "Nested phase wall times overlap; do not sum. Private reconciliation is visible through its actual nested reads and CPU stacks. This instrumented run is not acceptance timing.",
            cpuProfileWeights: {
              valid: weightedValid,
              reason: weightedValid ? "Aligned finite nonnegative timeDeltas" : "Invalid or unaligned timeDeltas; do not derive weighted CPU shares",
              sampleCount: Array.isArray(samples) ? samples.length : null,
              deltaCount: Array.isArray(deltas) ? deltas.length : null,
            },
            profile: profile.profile,
          },
        });
      } catch (error) {
        current?.delay.disable();
        current = undefined;
        session?.disconnect();
        session = undefined;
        process.send?.({
          type: "zenx-synthetic-backend-profile-result", operation, id, ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    control = control.then(execute, execute);
  });
}

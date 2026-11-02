import { FakeModel, type ModelRequest, type ModelEvent } from "../../../../src/model.js";

// Diagnostic-only module inserted into the owned synthetic Host checkout.
// Never shipped in production; never synthesizes model events or protocol receipts.
type RequestRecord = {
  ordinal: number;
  threadId: string;
  turnId: string | null;
  sampleId: string;
  noncePresent: boolean[];
  gateReleased: boolean;
  finished: boolean;
  aborted: boolean;
};
type Gate = { release: () => void; promise: Promise<void> };
type State = {
  caseId: string;
  threadId: string;
  nonces: string[];
  gateOrdinals: number[];
  requests: RequestRecord[];
  gates: Map<number, Gate>;
};

export function installSyntheticSteerGate(): void {
  if (process.env.ZENX_SYNTHETIC_STEER_GATE !== "1") return;
  const nonce = process.env.ZENX_SYNTHETIC_STEER_GATE_NONCE;
  if (!nonce || !/^[0-9a-f-]{36}$/i.test(nonce)) throw Error("Missing owned gate nonce");
  let state: State | undefined;
  const original = FakeModel.prototype.stream;
  const snapshot = () => state ? ({
    caseId: state.caseId, threadId: state.threadId,
    requests: state.requests.map(request => ({ ...request, noncePresent: [...request.noncePresent] })),
    heldOrdinals: [...state.gates.keys()],
  }) : null;
  const release = (active: State, ordinal: number) => {
    const gate = active.gates.get(ordinal);
    if (!gate) throw Error("No actual provider request is held at requested ordinal");
    active.gates.delete(ordinal);
    const record = active.requests.find(request => request.ordinal === ordinal);
    if (record) record.gateReleased = true;
    gate.release();
  };
  FakeModel.prototype.stream = async function* (request: ModelRequest): AsyncIterable<ModelEvent> {
    const active = state;
    const context = request.debugContext;
    if (!active || context?.purpose !== "turn" || context.threadId !== active.threadId) {
      yield* original.call(this, request);
      return;
    }
    if (active.requests.length >= 16) throw Error("Synthetic provider request bound exceeded");
    // Only private synthetic input is inspected; never return request payloads to logs.
    const body = JSON.stringify(request.messages);
    const record: RequestRecord = {
      ordinal: active.requests.length + 1,
      threadId: context.threadId, turnId: context.turnId, sampleId: context.sampleId,
      noncePresent: active.nonces.map(value => body.includes(value)),
      gateReleased: false, finished: false, aborted: false,
    };
    active.requests.push(record);
    try {
      if (active.gateOrdinals.includes(record.ordinal)) {
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        active.gates.set(record.ordinal, { release: resolve, promise });
        await new Promise<void>((done, reject) => {
          const aborted = () => {
            request.signal.removeEventListener("abort", aborted);
            reject(request.signal.reason ?? new Error("Synthetic gated request aborted"));
          };
          request.signal.addEventListener("abort", aborted, { once: true });
          promise.then(() => {
            request.signal.removeEventListener("abort", aborted);
            done();
          }, reject);
          if (request.signal.aborted) aborted();
        });
      }
      request.signal.throwIfAborted();
      yield* original.call(this, request);
    } finally {
      active.gates.delete(record.ordinal);
      record.aborted = request.signal.aborted;
      record.finished = true;
    }
  };
  process.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const command = raw as Record<string, unknown>;
    if (command.type !== "zenx-synthetic-steer-gate" || command.nonce !== nonce) return;
    const id = command.id;
    if (typeof id !== "string" || id.length > 100) return;
    try {
      if (command.operation === "arm") {
        if (state) throw Error("Disarm previous synthetic case before rearming");
        if (typeof command.caseId !== "string" || command.caseId.length === 0 || command.caseId.length > 100 ||
            typeof command.threadId !== "string" || command.threadId.length > 150 ||
            !command.threadId.startsWith("synthetic-send-") ||
            !Array.isArray(command.nonces) || command.nonces.length !== 3 ||
            !command.nonces.every(value => typeof value === "string" && value.length >= 16 && value.length <= 200) ||
            !Array.isArray(command.gateOrdinals) || command.gateOrdinals.length > 2 ||
            new Set(command.gateOrdinals).size !== command.gateOrdinals.length ||
            !command.gateOrdinals.every(value => value === 1 || value === 2)) throw Error("Invalid isolated case configuration");
        state = { caseId: command.caseId, threadId: command.threadId,
          nonces: command.nonces as string[], gateOrdinals: command.gateOrdinals as number[],
          requests: [], gates: new Map() };
      } else if (command.operation === "release") {
        if (!state || !Number.isSafeInteger(command.ordinal)) throw Error("No configured case or ordinal");
        release(state, command.ordinal as number);
      } else if (command.operation === "disarm") {
        if (state) for (const ordinal of [...state.gates.keys()]) release(state, ordinal);
        if (state?.requests.some(request => !request.finished)) {
          throw Error("Gates released; await actual native terminal and finished requests before disarm/rearm");
        }
        const result = snapshot();
        state = undefined;
        process.send?.({ type: "zenx-synthetic-steer-gate-result", id, ok: true, result });
        return;
      } else if (command.operation !== "status") throw Error("Unknown gate operation");
      process.send?.({ type: "zenx-synthetic-steer-gate-result", id, ok: true, result: snapshot() });
    } catch (error) {
      process.send?.({ type: "zenx-synthetic-steer-gate-result", id, ok: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  });
}

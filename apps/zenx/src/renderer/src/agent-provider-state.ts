import type { AgentProvidersApi } from "../../main/agent-providers/types.js";
import type { ModelSummary } from "../../protocol-client/types.js";

export function agentProviderError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function selectAgentModel(
  models: readonly ModelSummary[],
  preferred?: string,
): string {
  const visible = models.filter((model) => !model.hidden);
  return (
    visible.find((model) => model.id === preferred)?.id ??
    visible.find((model) => model.isDefault)?.id ??
    visible[0]?.id ??
    ""
  );
}

/** Event bursts request one read at a time, with one trailing refresh if needed. */
export function subscribeAgentRefresh(
  api: AgentProvidersApi,
  sessionId: string | null,
  refresh: () => Promise<void>,
  delay = 80,
): () => void {
  let closed = false;
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    timer = undefined;
    if (closed || running) return;
    dirty = false;
    running = true;
    try {
      await refresh();
    } finally {
      running = false;
      if (!closed && dirty) timer = setTimeout(() => void run(), delay);
    }
  };
  const dispose = api.onEvent((event) => {
    if (sessionId !== null && event.sessionId !== sessionId) return;
    dirty = true;
    if (!running && timer === undefined)
      timer = setTimeout(() => void run(), delay);
  });
  return () => {
    closed = true;
    clearTimeout(timer);
    dispose();
  };
}

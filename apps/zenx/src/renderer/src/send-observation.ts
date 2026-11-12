import type { ClientSendObservation } from "../../../../../src/client-observation.js";
let rendererClockDomain: string | undefined;
/** Called synchronously in the activated UI handler, before asynchronous work. */
export function observeSendActivation(
  action: "send" | "retry" = "send",
): ClientSendObservation {
  const monotonicNs = Math.floor(performance.now() * 1e6).toString();
  const wallTime = new Date().toISOString();
  rendererClockDomain ??= crypto.randomUUID();
  return {
    requestId: crypto.randomUUID(),
    action,
    clock: { domain: rendererClockDomain, monotonicNs, wallTime },
  };
}

/** Best-effort independent activation observation, including before Thread creation. */
export function reportSendActivation(
  observation: ClientSendObservation,
  threadId?: string,
): void {
  try {
    void window.zenx.protocol
      .request("zen/trace/client-activation", {
        ...(threadId === undefined ? {} : { threadId }),
        observation,
      })
      .then((receipt) => {
        if (!receipt?.observed)
          console.error("UI activation Trace not durably recorded");
      })
      .catch((error: unknown) =>
        console.error("UI activation Trace unavailable", error),
      );
  } catch (error) {
    console.error("UI activation Trace unavailable", error);
  }
}

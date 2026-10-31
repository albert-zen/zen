import { clientTimeZone } from "./composer-state.js";
import {
  observeSendActivation,
  reportSendActivation,
} from "./send-observation.js";
import { i18n } from "./i18n.js";
import type { Thread } from "../../protocol-client/index.js";

import type {
  NativeTurnRetryParams,
  NativeTurnRetryResult,
} from "../../../../../src/protocol/native/wire.js";

export type ManualTurnRetryParams = NativeTurnRetryParams;

/** Disposable request identity only. The Host owns eligibility and execution. */
export function createManualTurnRetryRequester(
  send: (params: ManualTurnRetryParams) => Promise<NativeTurnRetryResult>,
  id: () => string = () => crypto.randomUUID(),
  language: () => "zh-CN" | "en" = () =>
    (i18n.resolvedLanguage ?? i18n.language).startsWith("zh") ? "zh-CN" : "en",
  timezone: () => string | undefined = clientTimeZone,
) {
  const requests = new Map<
    string,
    {
      params: ManualTurnRetryParams;
      pending?: Promise<void>;
      accepted: boolean;
    }
  >();
  return (thread: Thread, expectedTurnId: string): Promise<void> => {
    const key = JSON.stringify([thread.id, expectedTurnId]);
    let request = requests.get(key);
    if (request?.pending !== undefined) return request.pending;
    if (request?.accepted) return Promise.resolve();
    const latest = thread.turns.at(-1);
    if (
      latest?.id !== expectedTurnId ||
      !["failed", "interrupted"].includes(latest.status) ||
      thread.turns.some((turn) => turn.status === "inProgress") ||
      thread.status.type === "active"
    )
      return Promise.reject(
        new Error(i18n.t("shell:manualRetryNoLongerAvailable")),
      );
    if (request === undefined) {
      const clientTimezone = timezone();
      request = {
        params: {
          threadId: thread.id,
          expectedTurnId,
          clientUserMessageId: id(),
          language: language(),
          ...(clientTimezone === undefined ? {} : { clientTimezone }),
        },
        accepted: false,
      };
      requests.set(key, request);
    }
    const current = request;
    const clientObservation = observeSendActivation("retry");
    // Defer dispatch until pending is installed so synchronous duplicate clicks
    // across main/side viewports share exactly one request and one identity.
    current.pending = Promise.resolve()
      .then(async () => {
        const result = await send({ ...current.params, clientObservation });
        if (typeof result?.turnId !== "string" || result.turnId.length === 0)
          throw new Error(i18n.t("shell:manualRetryUnconfirmed"));
        current.accepted = true;
      })
      .finally(() => {
        current.pending = undefined;
      });
    return current.pending;
  };
}

/** Shared by main and side viewports; composer text/images/selection are untouched. */
export const requestManualTurnRetry = createManualTurnRetryRequester(
  (params) => {
    if (params.clientObservation)
      reportSendActivation(params.clientObservation, params.threadId);
    return window.zenx.protocol.request("zen/turn/retry", params);
  },
);

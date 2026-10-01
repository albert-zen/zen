import { ZenXProtocolError } from "../protocol-client/protocol-client.js";
/** Product preset: reusable by any user, independent of personal workspace conventions. */
export const ALWAYS_ON_ASSISTANT_PROMPT = `You are this user's ongoing personal assistant in ZenX. Use the user's chosen name or the bound Room/member identity; Companion is a product preset label. The Room is your communication channel; the Thread is your working context.
First use the zenx_plugin discovery/read tool to load zenx-rooms, zenx-triggers and zenx-self-control when their tools are not yet disclosed. If a plugin is disabled or unavailable, tell the user what is missing; do not claim to have installed or enabled it.
Absorb new messages into ongoing work. Several messages may belong to one task; do not force one task or one reply per message. Prioritize corrections and changed instructions at your next model cycle.
Use zenx_rooms_post_message to send useful answers, questions, progress and results to the source Room. Send messages while work is in progress when useful. Your final Thread output is NOT automatically posted to the Room. Stay quiet when there is nothing useful to tell the user.
Use zenx_self_control_devices to discover configured devices. The thread tools zenx_threads_list, zenx_threads_read, zenx_threads_create, zenx_threads_send, zenx_threads_status and zenx_self_control_threads_wait accept an optional device; omit it for local work. Prefer inspecting and messaging existing threads. Read without spawning tasks. Create a thread only when useful and authorized. A remote agent uses its own machine's tools. Do not change device connections, credentials or permissions yourself.
Send guidance to ongoing work, not follow_up, unless the user explicitly wants work queued for later. Watch exact Thread/Turn identities, distinguish admission from completion, and report offline or unknown delivery honestly. Never blindly repeat a side-effecting remote request after a lost response.
Continue authorized tasks until done or a real decision is needed. Keep a concise record of goals, decisions, next actions and waits in your conversation. For thread completion use a thread Trigger. For a remote source, set sourceDevice and sourceWorkspace to the exact Fleet device and canonical workspace returned by discovery; keep the watched Thread identity exact. Native remote subscriptions reconnect and report source errors through the existing Trigger. Use zenx_self_control_threads_wait for a bounded immediate wait when useful, rather than creating recurring polling by default. Use existing timer or signal Triggers for time/event-driven follow-up. Give wakeup prompts the source Room ID so you can send the useful result there. Do not create unrelated recurring model work or claim a wakeup is installed before the tool confirms it.
Use zenx_rooms_workspace to explicitly read this source Room’s bounded planning notebook. Keep matters (goals, plans, status notes and exact Thread/Trigger references) and useful memory inspectable with zenx_rooms_update_workspace. Supply the last read expectedRevision; on conflict read again and merge deliberately, never overwrite a newer editor. Reference local work with device=local and its exact canonical workspace/Thread ID, or the discovered Fleet device/workspace/Thread ID. Notes are editable annotations, never proof of admission, running or completion; read real Thread/Trigger status separately. These tools do not execute referenced resources or create wakeups. Do not store secrets or silently inject mutable notes into context.
After a restart, inspect canonical threads and existing Triggers before resuming; do not repeat already accepted work. Respect the user's authorization and model-cost limits. No personal Work CLI or private directory convention is required.`;

import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
} from "../protocol-client/index.js";
export interface AssistantInputPort {
  request<
    M extends Extract<
      ClientRequestMethod,
      "thread/read" | "turn/start" | "turn/steer"
    >,
  >(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]>;
}
export async function deliverAssistantInput(
  port: AssistantInputPort,
  params: ClientRequestParams["turn/queue"],
  signal?: AbortSignal,
): Promise<{
  turnId: string;
  mode: "start" | "steer";
  expectedTurnId?: string;
}> {
  // Retry only definitive pre-admission races, with the same canonical client ID.
  // Transport failures/timeouts are never retried: admission may have happened.
  for (let attempt = 0; attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const { thread } = await port.request("thread/read", {
      threadId: params.threadId,
      includeTurns: true,
    });
    signal?.throwIfAborted();
    const active = thread.turns.find((turn) => turn.status === "inProgress");
    try {
      if (active) {
        const result = await port.request("turn/steer", {
          ...params,
          expectedTurnId: active.id,
        });
        return { ...result, mode: "steer", expectedTurnId: active.id };
      }
      const result = await port.request("turn/start", params);
      return { turnId: result.turn.id, mode: "start" };
    } catch (error) {
      const code =
        error instanceof ZenXProtocolError &&
        error.code === -32000 &&
        error.data &&
        typeof error.data === "object"
          ? (error.data as { zenCode?: unknown }).zenCode
          : undefined;
      if (code !== "thread_busy" && code !== "turn_not_running") throw error;
      if (attempt === 7) throw error;
    }
  }
  throw new Error("Assistant input was not admitted");
}

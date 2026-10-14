import type {
  Thread,
  ThreadItem,
  Turn,
} from "../../src/protocol-client/index.js";
import type { ApprovalCardState } from "../../src/renderer/src/approval-state.js";
import type { CanonicalItem } from "../../../../src/item.js";
export type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;
export type NativeTaskPhase =
  | "admitting"
  | "queued"
  | "running"
  | "cancel_requested"
  | "cancellation_unconfirmed"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";
export function runtimeCommand(
  id: string,
  command = "npm run check --workspace @zen/zenx",
  status: CommandItem["status"] = "completed",
): CommandItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
    toolName: "shell",
    toolArguments: { command },
    cwd: "/workspace/zen",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: "Checked component source.\nNo additional output yet.",
    exitCode: status === "completed" ? 0 : null,
    durationMs: null,
  };
}
export function runtimeTask(
  id: string,
  taskId: string,
  phase: NativeTaskPhase,
  status: CommandItem["status"] = "completed",
): CommandItem {
  const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(
    phase,
  );
  return {
    ...runtimeCommand(id, "npm run check --workspace @zen/zenx", status),
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: {
      status: phase,
      task_id: taskId,
      tool_name: "shell",
      timeout_ms: 60000,
      cancellation: "confirmable",
      resource_scope: "invocation",
      lifetime: "host_instance",
      exit_code: terminal ? (phase === "completed" ? 0 : 1) : null,
    },
    exitCode: 0,
  };
}
export function runtimeWait(id: string, taskId: string): CommandItem {
  return {
    ...runtimeTask(id, taskId, "running"),
    toolName: "wait",
    command: "wait",
    toolArguments: { task_id: taskId, yield_time_ms: 1000 },
    aggregatedOutput: "Waiting for additional task output.",
  };
}
export function runtimeMessage(id: string, text: string): ThreadItem {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}
export const runtimeIntro: ThreadItem[] = [
  {
    type: "userMessage",
    id: "runtime-user",
    clientId: null,
    content: [
      {
        type: "text",
        text: "检查 Agent 页的工具汇总、审批和停止状态。",
        text_elements: [],
      },
    ],
  },
  runtimeMessage("runtime-intro", "我会并行读取组件、检查页面，并运行验证。"),
];
export function runtimeThread(
  items: ThreadItem[] = [],
  status: Turn["status"] = "inProgress",
  id = "runtime-thread",
): Thread {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: now,
    updatedAt: now,
    recencyAt: null,
    status:
      status === "inProgress"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
    path: null,
    cwd: "/workspace/zen",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    canonicalItems: [],
    turns: [
      {
        id: "runtime-turn",
        items,
        itemsView: "full",
        status,
        error: null,
        startedAt: now - 3,
        completedAt: status === "inProgress" ? null : now,
        durationMs: status === "inProgress" ? null : 3000,
      },
    ],
  };
}
export const longApprovalCode =
  'const checks = await Promise.all([\n  tools.shell({ command: "npm run check --workspace @zen/zenx" }),\n  tools.shell({ command: "git diff --check" }),\n]);\nfor (const check of checks) text(check.output);\n// 保留原始结果；未获得许可前不执行。';
export const runtimeApproval: ApprovalCardState = {
  requestId: "runtime-approval",
  status: "pending",
  decision: null,
  params: {
    threadId: "runtime-thread",
    turnId: "runtime-turn",
    itemId: "approval-call",
    startedAtMs: 1,
    environmentId: null,
    reason: null,
    command: longApprovalCode,
    cwd: "/workspace/zen/apps/zenx/long-path-that-must-remain-visible",
    toolName: "run_code",
    toolArguments: { code: longApprovalCode, description: "检查组件与样式" },
    commandActions: [],
    proposedExecpolicyAmendment: null,
    networkApprovalContext: null,
    proposedNetworkPolicyAmendments: null,
  },
};
export function confirmedStopped(items: ThreadItem[]): Thread {
  const thread = runtimeThread(items, "interrupted");
  thread.canonicalItems = [
    {
      type: "turn_aborted",
      id: "runtime-abort",
      threadId: thread.id,
      turnId: "runtime-turn",
      createdAt: new Date().toISOString(),
      reason: "User requested interruption",
    } satisfies CanonicalItem,
  ];
  return thread;
}

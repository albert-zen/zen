export type ItemType =
  | "thread_metadata"
  | "turn_started"
  | "turn_completed"
  | "turn_aborted"
  | "user_message"
  | "agent_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "failure";

export interface ItemBase {
  id: string;
  threadId: string;
  turnId?: string;
  createdAt: string;
  type: ItemType;
}

export interface ThreadMetadataItem extends ItemBase {
  type: "thread_metadata";
  cwd: string;
  model: string;
  provider: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export interface TurnStartedItem extends ItemBase {
  type: "turn_started";
  turnId: string;
}

export interface TurnCompletedItem extends ItemBase {
  type: "turn_completed";
  turnId: string;
  status: "completed" | "failed";
}

export interface TurnAbortedItem extends ItemBase {
  type: "turn_aborted";
  turnId: string;
  reason: string;
}

export interface UserMessageItem extends ItemBase {
  type: "user_message";
  turnId: string;
  text: string;
}

export interface AgentMessageItem extends ItemBase {
  type: "agent_message";
  turnId: string;
  text: string;
}

export interface ReasoningItem extends ItemBase {
  type: "reasoning";
  turnId: string;
  summary: string;
}

export interface ToolCallItem extends ItemBase {
  type: "tool_call";
  turnId: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultItem extends ItemBase {
  type: "tool_result";
  turnId: string;
  callId: string;
  output: string;
  exitCode: number;
}

export interface FailureItem extends ItemBase {
  type: "failure";
  turnId: string;
  code: string;
  message: string;
}

export type CanonicalItem =
  | ThreadMetadataItem
  | TurnStartedItem
  | TurnCompletedItem
  | TurnAbortedItem
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | FailureItem;

export type SandboxMode = "danger-full-access";
export type ApprovalPolicy = "always" | "never";
export type ApprovalDecision =
  "accept" | "acceptForSession" | "decline" | "cancel";

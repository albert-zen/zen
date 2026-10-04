import type {
  Thread,
  ModelSummary,
  FilePermissionMode,
} from "../../protocol-client/types.js";

/** Agent engines are distinct from the model-service providers configured inside Zen. */
export type AgentProviderKind =
  "zen" | "codex" | "claude-code" | "opencode" | "deepseek-harness";
export interface AgentProviderInstance {
  id: string;
  kind: AgentProviderKind;
  name: string;
  /** Host-local executable path/name; never a shell command. */
  executable?: string;
  defaultModel?: string;
}
export interface AgentSessionBinding {
  id: string;
  hostId: string;
  providerInstanceId: string;
  nativeSessionId: string;
  cwd: string;
}
export interface AgentProviderCapabilities {
  permissionModes?: readonly FilePermissionMode[];
  models: boolean;
  interrupt: boolean;
  resume: boolean;
  changeModel: boolean;
  approvals: boolean;
}
export interface AgentSessionSnapshot {
  binding: AgentSessionBinding;
  /** A display projection, not a second canonical history. */
  thread: Thread;
  model: string;
}
export type AgentProviderEvent =
  | { type: "changed"; sessionId: string }
  | { type: "approvalResolved"; sessionId: string; requestId: string }
  | {
      type: "error";
      sessionId?: string;
      providerInstanceId?: string;
      message: string;
    }
  | {
      type: "approval";
      sessionId: string;
      requestId: string;
      title: string;
      detail: string;
    };
export interface AgentNativeSession {
  nativeSessionId: string;
  thread: Thread;
  model: string;
}
export interface AgentProviderAdapter {
  readonly capabilities: AgentProviderCapabilities;
  models(): Promise<ModelSummary[]>;
  create(input: {
    cwd: string;
    model?: string;
    permissionMode: FilePermissionMode;
  }): Promise<AgentNativeSession>;
  read(nativeSessionId: string): Promise<AgentNativeSession>;
  send(
    nativeSessionId: string,
    input: { text: string; model?: string },
  ): Promise<void>;
  interrupt(nativeSessionId: string): Promise<void>;
  respondApproval(
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<void>;
  onEvent(listener: (event: AgentProviderEvent) => void): () => void;
  dispose(): Promise<void>;
}
export interface AgentProvidersApi {
  list(): Promise<AgentProviderInstance[]>;
  capabilities(instanceId: string): Promise<AgentProviderCapabilities>;
  save(instance: AgentProviderInstance): Promise<AgentProviderInstance>;
  models(instanceId: string): Promise<ModelSummary[]>;
  sessions(): Promise<AgentSessionBinding[]>;
  approvals(
    sessionId: string,
  ): Promise<Extract<AgentProviderEvent, { type: "approval" }>[]>;
  create(input: {
    providerInstanceId: string;
    cwd: string;
    model?: string;
    permissionMode: FilePermissionMode;
  }): Promise<AgentSessionSnapshot>;
  read(sessionId: string): Promise<AgentSessionSnapshot>;
  send(
    sessionId: string,
    input: { text: string; model?: string },
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<void>;
  onEvent(listener: (event: AgentProviderEvent) => void): () => void;
}

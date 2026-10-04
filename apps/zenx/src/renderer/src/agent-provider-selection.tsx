import { createContext, useContext, type ReactNode } from "react";
import type { AgentProviderInstance } from "../../main/agent-providers/types.js";

export interface AgentProviderSelection {
  instances: readonly AgentProviderInstance[];
  value: string;
  /** Omitted for an existing conversation whose native engine identity is fixed. */
  onChange?(id: string): void;
  disabled?: boolean;
}

const AgentProviderContext = createContext<AgentProviderSelection | null>(null);

/** Couples display-only engine selection to the shared Composer model picker. */
export function AgentProviderModelScope({
  selection,
  children,
}: {
  selection: AgentProviderSelection | null;
  children?: ReactNode;
}) {
  return (
    <AgentProviderContext.Provider value={selection}>
      {children}
    </AgentProviderContext.Provider>
  );
}

export function useAgentProviderSelection() {
  return useContext(AgentProviderContext);
}

export function agentProviderLabel(instance: AgentProviderInstance): string {
  const engine =
    instance.kind === "codex"
      ? "Codex"
      : instance.kind === "opencode"
        ? "OpenCode"
        : instance.kind === "zen"
          ? "Zen"
          : instance.kind;
  return instance.name.toLocaleLowerCase().includes(engine.toLocaleLowerCase())
    ? instance.name
    : `${instance.name} · ${engine}`;
}

/** Product state only. Tool execution and model admission belong to the Host. */
export type BoardOwner =
  | { kind: "thread"; threadId: string }
  | { kind: "room"; roomId: string; threadId: string };
export type BoardValue = string | number | boolean | null;
export type BoardValues = Record<string, BoardValue>;
export type BoardBlock =
  | { id: string; kind: "note"; title?: string; text: string }
  | {
      id: string;
      kind: "metric";
      title: string;
      value: string;
      detail?: string;
    }
  | { id: string; kind: "progress"; title: string; value: number; max?: number }
  | {
      id: string;
      kind: "field";
      label: string;
      field: string;
      input?: "text" | "textarea" | "select" | "checkbox";
      options?: string[];
      placeholder?: string;
    }
  | {
      id: string;
      kind: "action";
      label: string;
      event: string;
      emphasis?: boolean;
    };
export type BoardAction =
  | { kind: "set"; values: BoardValues }
  | { kind: "navigate"; route: string }
  | { kind: "submit"; text: string }
  | { kind: "script"; command: string; timeoutMs?: number }
  | {
      kind: "if";
      field: string;
      equals: BoardValue;
      then: BoardAction[];
      otherwise?: BoardAction[];
    };
export interface BoardEvent {
  id: string;
  label: string;
  actions: BoardAction[];
}
export interface BoardDocument {
  id: string;
  title: string;
  summary: string;
  owner: BoardOwner;
  /** Convenience templates compose freely; custom HTML is not restricted to them. */
  blocks: BoardBlock[];
  events: BoardEvent[];
  initialValues?: BoardValues;
  /** Isolated HTML/CSS/JS. Receives zenxPluginUi with board context and draft/event commands. */
  html?: string;
}
export interface BoardSnapshot {
  document: BoardDocument;
  revision: number;
  draftRevision: number;
  values: BoardValues;
  pinned: boolean;
}
export interface BoardEventResult {
  snapshot: BoardSnapshot;
  outcomes: Array<{ kind: string; result?: unknown }>;
  navigation: string[];
  /** Explicit partial failure; completed actions are never automatically replayed. */
  error?: string;
  /** Owner-readable transient local diagnostic; never stored or model-projected. */
  errorDetail?: string;
}
export function boardOwnerKey(owner: BoardOwner): string {
  return owner.kind === "thread"
    ? `thread:${owner.threadId}`
    : `room:${owner.roomId}`;
}

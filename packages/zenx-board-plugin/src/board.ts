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
export type BoardNavigationTarget =
  | { kind: "url"; url: string }
  | { kind: "browser" | "external-browser"; id: string };
export type BoardAction =
  | { kind: "set"; values: BoardValues }
  | { kind: "navigate"; target: BoardNavigationTarget }
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
  /** Independent product document address; omitted means the legacy default. */
  instanceKey?: string;
  document: BoardDocument;
  revision: number;
  draftRevision: number;
  values: BoardValues;
  pinned: boolean;
}
export interface BoardEventResult {
  snapshot: BoardSnapshot;
  outcomes: Array<{ kind: string; result?: unknown }>;
  navigation: BoardNavigationTarget[];
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

/** Addressing is separate from authored BoardDocument.id and execution ownership. */
export function normalizeBoardInstanceKey(value: unknown = "default"): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error("Invalid Board instanceKey");
  return value;
}

export function boardDocumentKey(
  owner: BoardOwner,
  instanceKey?: string,
): string {
  const address = normalizeBoardInstanceKey(instanceKey);
  // Do not migrate or shadow the pre-existing default owner's storage address.
  return address === "default"
    ? boardOwnerKey(owner)
    : `document:${JSON.stringify([boardOwnerKey(owner), address])}`;
}

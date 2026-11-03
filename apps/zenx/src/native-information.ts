import type {
  InformationLayout,
  InformationType,
  InformationWidget,
} from "./information-layout.js";
import type { SidebarOwner } from "./thread-sidebar-state.js";

/** Human presentation edits only; identities and data bindings are Host-owned. */
export type NativeInformationEdit =
  | {
      op: "add";
      type: InformationType;
      config?: InformationWidget["config"];
      before?: string | null;
    }
  | { op: "move"; id: string; before: string | null }
  | {
      op: "set";
      id: string;
      visible?: boolean;
      collapsed?: boolean;
      config?: InformationWidget["config"];
    }
  | { op: "remove"; id: string }
  | { op: "reset" };
export interface NativeInformationSnapshot {
  owner: SidebarOwner;
  revision: number;
  /** Exact saved/default projection basis, not a permission or provider grant. */
  basis: string;
  layout: InformationLayout;
  members: { threadId: string; name?: string }[];
  /** Actual current assistant member, or the exact Thread owner. */
  resourceThreadId?: string;
}
export interface NativeInformationUpdate {
  owner: SidebarOwner;
  expectedRevision: number;
  basis: string;
  operations: NativeInformationEdit[];
  /** Human-selected current member for newly added/reset Thread components. */
  resourceThreadId?: string;
}
export interface NativeInformationApi {
  read(owner: SidebarOwner | string): Promise<NativeInformationSnapshot>;
  update(
    request: NativeInformationUpdate,
  ): Promise<NativeInformationSnapshot & { applied: boolean }>;
}

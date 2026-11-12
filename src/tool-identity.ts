/** Shared tool ownership types; safe for native clients without Host runtime imports. */
export type ToolBundleKind = "builtin" | "plugin" | "external";

export interface ToolBundleIdentity {
  kind: ToolBundleKind;
  id: string;
}

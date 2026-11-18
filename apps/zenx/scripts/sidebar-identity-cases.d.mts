export interface SidebarIdentityCase {
  lang: "en" | "zh-CN";
  title: string;
  siblingTitle: string;
}
export const sidebarIdentityCases: Readonly<
  Record<string, SidebarIdentityCase>
>;
export function sidebarIdentityCase(name: string): SidebarIdentityCase;

export interface SidebarOwner {
  kind: "thread" | "room";
  id: string;
}
type Resource = { resourceThreadId?: string };
export type ThreadSidebarTab = (
  | { kind: "file"; path: string }
  | { kind: "webpage"; id: string; url: string }
  | { kind: "browser" | "external-browser"; id: string }
  | { kind: "plugin"; pluginId: string; panelId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "terminal" | "computer" }
  | { kind: "custom"; id: string }
) &
  Resource;
export interface ThreadSidebarState {
  owner: SidebarOwner;
  revision: number;
  open: boolean;
  fullscreen: boolean;
  tabs: ThreadSidebarTab[];
  selectedTab: string | null;
  resourceThreadId: string | null;
}
export type ThreadSidebarPatch = Partial<
  Pick<
    ThreadSidebarState,
    "open" | "fullscreen" | "tabs" | "selectedTab" | "resourceThreadId"
  >
>;
export interface ThreadSidebarUpdate {
  owner: SidebarOwner;
  expectedRevision: number;
  patch: ThreadSidebarPatch;
}
export type SidebarAdmission = () => void;
/** Internal Host provenance; IPC does not accept this from renderer payloads. */
export type SidebarChangeSource =
  { kind: "ui" | "host" } | { kind: "tool"; threadId: string; callId: string };
export interface ThreadSidebarPort {
  read(
    owner: SidebarOwner | string,
    admit?: SidebarAdmission,
  ): Promise<ThreadSidebarState>;
  update(
    request: ThreadSidebarUpdate,
    admit?: SidebarAdmission,
    source?: SidebarChangeSource,
  ): Promise<{ applied: boolean; state: ThreadSidebarState }>;
}
export interface ThreadSidebarApi extends ThreadSidebarPort {
  onChanged(listener: (state: ThreadSidebarState) => void): () => void;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Sidebar object required");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw Error("Unknown sidebar field");
}
function string(value: unknown, maximum = 2048): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw Error("Invalid sidebar string");
  return value;
}
export function sidebarOwner(value: SidebarOwner | string): SidebarOwner {
  if (typeof value === "string") return { kind: "thread", id: string(value) };
  const input = object(value);
  only(input, ["kind", "id"]);
  if (input.kind !== "thread" && input.kind !== "room")
    throw Error("Invalid sidebar owner");
  return { kind: input.kind, id: string(input.id) };
}
export const sidebarOwnerKey = (owner: SidebarOwner | string) => {
  const value = sidebarOwner(owner);
  return `${value.kind}:${value.id}`;
};
export function emptySidebarState(
  owner: SidebarOwner | string,
): ThreadSidebarState {
  return {
    owner: sidebarOwner(owner),
    revision: 0,
    open: false,
    fullscreen: false,
    tabs: [],
    selectedTab: null,
    resourceThreadId: null,
  };
}
export function sidebarTabId(tab: ThreadSidebarTab): string {
  const resource = tab.resourceThreadId
    ? `@${encodeURIComponent(tab.resourceThreadId)}:`
    : "";
  switch (tab.kind) {
    case "file":
      return `file:${resource}${tab.path.replaceAll("%", "%25").replace(/^@/u, "%40")}`;
    case "webpage":
      return `webpage:${resource}${tab.id}`;
    case "browser":
    case "external-browser":
      return `${tab.kind}:${resource}${tab.id}`;
    case "plugin":
      return `plugin:${resource}${tab.pluginId}:${tab.panelId}`;
    case "thread":
      return `thread:${tab.threadId}`;
    case "custom":
      return `custom:${tab.id}`;
    default:
      return `${tab.kind}${resource ? `:${resource.slice(0, -1)}` : ""}`;
  }
}
function parseTab(value: unknown): ThreadSidebarTab {
  const tab = object(value);
  const kind = string(tab.kind, 40);
  const resourceThreadId =
    tab.resourceThreadId === undefined
      ? undefined
      : string(tab.resourceThreadId);
  const resource = resourceThreadId === undefined ? {} : { resourceThreadId };
  const common = ["kind", "resourceThreadId"];
  if (kind === "file") {
    only(tab, [...common, "path"]);
    const path = string(tab.path, 4096);
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      /^[A-Za-z]:/u.test(path) ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw Error(
        "Sidebar file path must be normalized and workspace-relative",
      );
    return { kind, path, ...resource };
  }
  if (kind === "webpage") {
    only(tab, [...common, "id", "url"]);
    const url = string(tab.url, 8192);
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw Error("Unsupported sidebar URL");
    return {
      kind,
      id: tab.id === undefined ? crypto.randomUUID() : string(tab.id),
      url,
      ...resource,
    };
  }
  if (kind === "browser" || kind === "external-browser" || kind === "custom") {
    only(tab, [...common, "id"]);
    return { kind, id: string(tab.id), ...resource };
  }
  if (kind === "plugin") {
    only(tab, [...common, "pluginId", "panelId"]);
    return {
      kind,
      pluginId: string(tab.pluginId),
      panelId: string(tab.panelId),
      ...resource,
    };
  }
  if (kind === "thread") {
    only(tab, ["kind", "threadId"]);
    return { kind, threadId: string(tab.threadId) };
  }
  if (kind === "terminal" || kind === "computer") {
    only(tab, common);
    return { kind, ...resource };
  }
  throw Error("Unknown sidebar tab kind");
}
export function sidebarTabFromId(id: string): ThreadSidebarTab {
  const colon = id.indexOf(":");
  const kind = colon < 0 ? id : id.slice(0, colon);
  let rest = colon < 0 ? "" : id.slice(colon + 1);
  let resourceThreadId: string | undefined;
  if (rest.startsWith("@") && !["thread", "custom"].includes(kind)) {
    const split = rest.indexOf(":");
    resourceThreadId = decodeURIComponent(
      rest.slice(1, split < 0 ? undefined : split),
    );
    rest = split < 0 ? "" : rest.slice(split + 1);
  }
  const resource = resourceThreadId ? { resourceThreadId } : {};
  if (kind === "file")
    return parseTab({
      kind,
      path: rest.replace(/%40|%25/giu, (value) =>
        value.toLowerCase() === "%40" ? "@" : "%",
      ),
      ...resource,
    });
  if (kind === "thread") return parseTab({ kind, threadId: rest });
  if (kind === "plugin") {
    const split = rest.indexOf(":");
    return parseTab({
      kind,
      pluginId: rest.slice(0, split),
      panelId: rest.slice(split + 1),
      ...resource,
    });
  }
  if (kind === "terminal" || kind === "computer")
    return parseTab({ kind, ...resource });
  if (kind === "webpage")
    throw Error(
      "Webpage descriptor must retain its original URL and intent ID",
    );
  return parseTab({ kind, id: rest, ...resource });
}
export function parseSidebarUpdate(value: unknown): ThreadSidebarUpdate {
  const input = object(value);
  only(input, ["owner", "expectedRevision", "patch"]);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 0
  )
    throw Error("Invalid sidebar revision");
  const source = object(input.patch);
  only(source, [
    "open",
    "fullscreen",
    "tabs",
    "selectedTab",
    "resourceThreadId",
  ]);
  const patch: ThreadSidebarPatch = {};
  for (const key of ["open", "fullscreen"] as const)
    if (source[key] !== undefined) {
      if (typeof source[key] !== "boolean")
        throw Error("Invalid sidebar display flag");
      patch[key] = source[key];
    }
  for (const key of ["selectedTab", "resourceThreadId"] as const)
    if (source[key] !== undefined)
      patch[key] = source[key] === null ? null : string(source[key], 8192);
  if (source.tabs !== undefined) {
    if (!Array.isArray(source.tabs) || source.tabs.length > 64)
      throw Error("Sidebar accepts at most 64 tabs");
    patch.tabs = source.tabs.map(parseTab);
    if (new Set(patch.tabs.map(sidebarTabId)).size !== patch.tabs.length)
      throw Error("Duplicate sidebar tab IDs");
  }
  return {
    owner: sidebarOwner(input.owner as SidebarOwner),
    expectedRevision: input.expectedRevision as number,
    patch,
  };
}
export function applySidebarPatch(
  state: ThreadSidebarState,
  input: ThreadSidebarPatch,
): ThreadSidebarState {
  const { patch } = parseSidebarUpdate({
    owner: state.owner,
    expectedRevision: state.revision,
    patch: input,
  });
  const next = {
    ...structuredClone(state),
    ...patch,
    revision: state.revision + 1,
  };
  if (
    next.selectedTab &&
    !next.tabs.some((tab) => sidebarTabId(tab) === next.selectedTab)
  ) {
    if (patch.selectedTab !== undefined)
      throw Error("Selected sidebar tab is absent");
    next.selectedTab = next.tabs[0] ? sidebarTabId(next.tabs[0]) : null;
  }
  return next;
}

/** Private in-process transport only. Existing native Browser state owns authority. */
export interface BrowserModelRoute {
  ownerThreadId: string;
  sessionId: string;
  sessionEpoch: string;
  backend?: string;
  connectionId?: string;
  generation?: string;
  tabId?: string;
  targetId?: string;
}
export interface BrowserModelTargets {
  route: BrowserModelRoute;
  targets: Array<{ tabId: string; targetId: string }>;
}
const routeKey = Symbol("Browser native route");
const targetsKey = Symbol("Browser native targets");
const sidebarKey = Symbol("Browser sidebar admission");
const trusted = new WeakSet<object>();
function attach<T extends object>(target: T, key: symbol, value: object): T {
  const copy = structuredClone(value);
  const freeze = (v: object): void => {
    for (const item of Object.values(v))
      if (item !== null && typeof item === "object") freeze(item);
    Object.freeze(v);
  };
  freeze(copy);
  trusted.add(copy);
  Object.defineProperty(target, key, {
    value: copy,
    enumerable: true,
    configurable: true,
  });
  return target;
}
function read<T>(target: unknown, key: symbol): T | undefined {
  if (target === null || typeof target !== "object") return;
  const value = (target as Record<symbol, unknown>)[key];
  return value !== null && typeof value === "object" && trusted.has(value)
    ? (value as T)
    : undefined;
}
export const readBrowserModelRoute = (value: unknown) =>
  read<BrowserModelRoute>(value, routeKey);
export const readBrowserModelTargets = (value: unknown) =>
  read<BrowserModelTargets>(value, targetsKey);
export const readBrowserSidebarTargets = (value: unknown) =>
  read<BrowserModelRoute[]>(value, sidebarKey);
export function attachBrowserModelRoute<T extends object>(
  target: T,
  value: BrowserModelRoute,
): T {
  if (!isBrowserModelRoute(value))
    throw Error("Invalid internal Browser route");
  return attach(target, routeKey, value);
}
export function attachBrowserModelTargets<T extends object>(
  target: T,
  value: BrowserModelTargets,
): T {
  // Oversized metadata must not erase a completed native operation's result.
  return isBrowserModelTargets(value)
    ? attach(target, targetsKey, value)
    : target;
}
export function attachBrowserSidebarTargets<T extends object>(
  target: T,
  value: BrowserModelRoute[],
): T {
  if (!isBrowserSidebarTargets(value))
    throw Error("Invalid internal Browser sidebar targets");
  return attach(target, sidebarKey, value);
}
export function copyBrowserModelContext<T extends object>(
  source: unknown,
  target: T,
): T {
  const route = readBrowserModelRoute(source),
    sidebar = readBrowserSidebarTargets(source);
  if (route) attachBrowserModelRoute(target, route);
  if (sidebar) attachBrowserSidebarTargets(target, sidebar);
  return target;
}
export function copyBrowserModelTargets<T extends object>(
  source: unknown,
  target: T,
): T {
  const value = readBrowserModelTargets(source);
  if (value) attachBrowserModelTargets(target, value);
  const sidebar = readBrowserSidebarTargets(source);
  return sidebar ? attachBrowserSidebarTargets(target, sidebar) : target;
}
const string = (v: unknown) =>
  typeof v === "string" && v.length > 0 && v.length <= 4096;
export function isBrowserModelRoute(
  value: unknown,
): value is BrowserModelRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    ["ownerThreadId", "sessionId", "sessionEpoch"].every((k) => string(v[k])) &&
    Object.keys(v).every(
      (k) =>
        [
          "ownerThreadId",
          "sessionId",
          "sessionEpoch",
          "backend",
          "connectionId",
          "generation",
          "tabId",
          "targetId",
        ].includes(k) && string(v[k]),
    ) &&
    (v.tabId === undefined) === (v.targetId === undefined) &&
    (v.connectionId === undefined) === (v.generation === undefined)
  );
}
export function isBrowserModelTargets(
  value: unknown,
): value is BrowserModelTargets {
  if (!value || typeof value !== "object") return false;
  const v = value as BrowserModelTargets;
  return (
    isBrowserModelRoute(v.route) &&
    Array.isArray(v.targets) &&
    v.targets.length <= 4096 &&
    v.targets.every(
      (t) =>
        t &&
        Object.keys(t).length === 2 &&
        string(t.tabId) &&
        string(t.targetId),
    )
  );
}
export function isBrowserSidebarTargets(
  value: unknown,
): value is BrowserModelRoute[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(isBrowserModelRoute)
  );
}

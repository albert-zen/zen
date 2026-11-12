/** Renderer-only layout preference; never Thread or Host state. */
export const SIDEBAR_WIDTH_KEY = "zenx.sidebar.width";
export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_OVERLAY_BREAKPOINT = 720;
const MIN_WORKSPACE_WIDTH = 480;

export function sidebarWidthLimit(containerWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.floor(containerWidth - MIN_WORKSPACE_WIDTH),
    ),
  );
}

export function clampSidebarWidth(
  value: number,
  containerWidth: number,
): number {
  return Math.round(
    Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(sidebarWidthLimit(containerWidth), value),
    ),
  );
}

export function readSidebarWidth(storage: Pick<Storage, "getItem">): number {
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_KEY);
    const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(value) &&
      value >= SIDEBAR_MIN_WIDTH &&
      value <= SIDEBAR_MAX_WIDTH
      ? Math.round(value)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

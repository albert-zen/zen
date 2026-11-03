interface PointerRefusal {
  point: { x: number; y: number };
  selectedPID?: number;
  axHitStatus?: number;
  axPIDStatus?: number;
  hitPID?: number;
  legacyOccluderPID?: number;
}

const signed32 = (value: number) =>
  Number.isSafeInteger(value) &&
  value >= -2_147_483_648 &&
  value <= 2_147_483_647;

/** Diagnostic text only. A later read never authorizes input or replaces refusal. */
export function nativePointerRefusal(
  message: string,
): PointerRefusal | undefined {
  const ax =
    /\(point=([^,()]+),([^,()]+), selectedPID=(\d+), axHitStatus=(-?\d+), axPIDStatus=(-?\d+|not_queried), hitPID=(-?\d+|unknown)\)/.exec(
      message,
    );
  if (ax) {
    const x = Number(ax[1]),
      y = Number(ax[2]);
    const selectedPID = Number(ax[3]),
      axHitStatus = Number(ax[4]);
    const axPIDStatus = ax[5] === "not_queried" ? undefined : Number(ax[5]);
    const hitPID = ax[6] === "unknown" ? undefined : Number(ax[6]);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !signed32(selectedPID) ||
      selectedPID <= 0 ||
      !signed32(axHitStatus) ||
      (axPIDStatus !== undefined && !signed32(axPIDStatus)) ||
      (hitPID !== undefined && !signed32(hitPID))
    )
      return undefined;
    return { point: { x, y }, selectedPID, axHitStatus, axPIDStatus, hitPID };
  }
  const point = /, point=([^,]+),([^,]+), occluderBounds=/.exec(message);
  if (!point) return undefined;
  const x = Number(point[1]),
    y = Number(point[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const rawPID = /occluderPID=(\d+),/.exec(message)?.[1];
  const pid = rawPID === undefined ? undefined : Number(rawPID);
  if (pid !== undefined && (!signed32(pid) || pid <= 0)) return undefined;
  return { point: { x, y }, legacyOccluderPID: pid };
}

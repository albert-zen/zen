/** App-owned identity for the separately packaged, narrowly scoped UIA client. */
export const STRICT_UIA_PROVIDER_ID = "zenx-winapp-uia";
export const STRICT_UIA_BUILD = "zenx-winapp-0.3.1-af0.2";
export const STRICT_UIA_VERSION = "0.3.1-zenx.af0.2";
export const STRICT_UIA_UPSTREAM = "c8ada4a403c43b96780b87abc454cba51f649c60";
export interface StrictUiaBuildMetadata {
  schemaVersion: 1;
  contractVersion: 1;
  providerBuild: string;
  upstreamCommit: string;
  patchSha256: string;
  sourceLockSha256: string;
  dependencyLockSha256: string;
}

export interface StrictUiaRoot {
  hwnd: string;
  pid: number;
  processStartTimeTicks: string;
  className: string;
  runtimeId: number[];
}
export interface StrictUiaControl {
  hwnd: string;
  pid: number;
  nativeClassName: string;
  runtimeId: number[];
  name: string;
  automationId: string;
  className: string;
  frameworkId: string;
  controlType: number;
  bounds: { left: number; top: number; width: number; height: number };
  enabled: boolean;
  offscreen: boolean;
  password: boolean;
  invokePattern: boolean;
  valuePattern: boolean;
  valueReadOnly: boolean | null;
}
export type StrictUiaOperation = "inspect" | "invoke" | "set_value";
export interface StrictUiaReply {
  schemaVersion: 1;
  contractVersion: 1;
  providerBuild: string;
  upstreamCommit: string;
  autoSetFocus: boolean | null;
  operation: StrictUiaOperation;
  outcome: "completed" | "not_dispatched" | "unknown";
  error: string | null;
  root?: StrictUiaRoot;
  controls?: StrictUiaControl[];
  value?: string;
}

export function validateStrictUiaProbe(raw: string): void {
  const value = record(JSON.parse(raw));
  exactKeys(value, [
    "schemaVersion",
    "contractVersion",
    "providerBuild",
    "upstreamCommit",
    "autoSetFocus",
  ]);
  validateIdentity(value);
  if (value.autoSetFocus !== false)
    throw new Error("Strict UIA client did not report live AutoSetFocus=false");
}

export function parseStrictUiaReply(
  raw: string,
  operation: StrictUiaOperation,
): StrictUiaReply {
  const value = record(JSON.parse(raw));
  validateIdentity(value);
  if (
    value.operation !== operation ||
    !["completed", "not_dispatched", "unknown"].includes(
      String(value.outcome),
    ) ||
    (value.autoSetFocus !== false &&
      value.autoSetFocus !== true &&
      value.autoSetFocus !== null) ||
    (value.error !== null && !boundedString(value.error, 256))
  )
    throw new Error("Invalid strict UIA reply");
  const keys = [
    "schemaVersion",
    "contractVersion",
    "providerBuild",
    "upstreamCommit",
    "autoSetFocus",
    "operation",
    "outcome",
    "error",
  ];
  if (value.outcome === "completed") {
    if (value.autoSetFocus !== false || value.error !== null)
      throw new Error(
        "Strict UIA success lacks live non-activating client evidence",
      );
    if (operation === "inspect") {
      validateStrictUiaRoot(value.root);
      if (!Array.isArray(value.controls) || value.controls.length > 256)
        throw new Error("Invalid strict UIA controls");
      value.controls.forEach(validateStrictUiaControl);
      keys.push("root", "controls");
    } else if (operation === "set_value") {
      if (!boundedString(value.value, 4000))
        throw new Error("Invalid strict UIA value readback");
      keys.push("value");
    }
  } else if (!value.error)
    throw new Error("Strict UIA refusal must identify its reason");
  exactKeys(value, keys);
  return value as unknown as StrictUiaReply;
}

export function validateStrictUiaRoot(
  value: unknown,
): asserts value is StrictUiaRoot {
  const root = record(value);
  exactKeys(root, [
    "hwnd",
    "pid",
    "processStartTimeTicks",
    "className",
    "runtimeId",
  ]);
  if (
    !handle(root.hwnd, false) ||
    !pid(root.pid) ||
    !decimal(root.processStartTimeTicks) ||
    !boundedString(root.className, 1024) ||
    !runtimeId(root.runtimeId)
  )
    throw new Error("Invalid strict UIA root identity");
}
export function validateStrictUiaControl(
  value: unknown,
): asserts value is StrictUiaControl {
  const control = record(value);
  exactKeys(control, [
    "hwnd",
    "pid",
    "nativeClassName",
    "runtimeId",
    "name",
    "automationId",
    "className",
    "frameworkId",
    "controlType",
    "bounds",
    "enabled",
    "offscreen",
    "password",
    "invokePattern",
    "valuePattern",
    "valueReadOnly",
  ]);
  if (
    !handle(control.hwnd, true) ||
    !pid(control.pid) ||
    !runtimeId(control.runtimeId, control.hwnd === "0") ||
    ![
      "nativeClassName",
      "name",
      "automationId",
      "className",
      "frameworkId",
    ].every((key) => boundedString(control[key], 1024)) ||
    !integer(control.controlType) ||
    ![
      "enabled",
      "offscreen",
      "password",
      "invokePattern",
      "valuePattern",
    ].every((key) => typeof control[key] === "boolean") ||
    (control.valueReadOnly !== null &&
      typeof control.valueReadOnly !== "boolean")
  )
    throw new Error("Invalid strict UIA control identity");
  const bounds = record(control.bounds);
  exactKeys(bounds, ["left", "top", "width", "height"]);
  if (
    !Object.values(bounds).every(integer) ||
    (bounds.width as number) < 0 ||
    (bounds.height as number) < 0
  )
    throw new Error("Invalid strict UIA bounds");
}
function validateIdentity(value: Record<string, unknown>): void {
  if (
    value.schemaVersion !== 1 ||
    value.contractVersion !== 1 ||
    value.providerBuild !== STRICT_UIA_BUILD ||
    value.upstreamCommit !== STRICT_UIA_UPSTREAM
  )
    throw new Error("Strict UIA provider contract identity mismatch");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid strict UIA object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(","))
    throw new Error("Unexpected strict UIA fields");
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
function integer(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647
  );
}
function pid(value: unknown): value is number {
  return integer(value) && value > 0;
}
function runtimeId(value: unknown, allowEmpty = false): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= (allowEmpty ? 0 : 1) &&
    value.length <= 64 &&
    value.every(integer)
  );
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value);
}
function handle(value: unknown, zero: boolean): value is string {
  return (zero && value === "0") || decimal(value);
}

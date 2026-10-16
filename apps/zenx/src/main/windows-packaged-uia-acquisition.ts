/** Opt-in smoke diagnostics: accept only bounded categorical observations. */
const apartments = ["unavailable", "sta", "mta", "na", "main_sta", "other"];
const owner = ["unavailable", "matched", "mismatched"];
const budgets = ["unavailable", "default", "nondefault"];
const nativeSchema: Record<string, readonly string[] | "bool" | "hresult"> = {
  beforeApartment: apartments,
  afterApartment: apartments,
  beforeApartmentHresult: "hresult",
  afterApartmentHresult: "hresult",
  connectionBudget: budgets,
  transactionBudget: budgets,
  autoFocus: ["unavailable", "disabled", "enabled"],
  ownerBefore: owner,
  ownerAfter: owner,
  outcome: ["not_observed", "returned", "threw"],
  errorCategory: ["none", "com", "other"],
  hresult: "hresult",
  sameClientThread: "bool",
  observerFailed: "bool",
};
const fixtureSchema = Object.fromEntries(
  [
    "readyDispatched",
    "messageLoopTickObserved",
    "uiaRootEntered",
    "uiaRootReturned",
    "uiaRootNonzero",
    "msaaClientEntered",
    "msaaClientReturned",
    "msaaClientNonzero",
    "otherEntered",
    "otherReturned",
    "otherNonzero",
    "observerFailed",
  ].map((key) => [key, "bool" as const]),
);
export function parseAcquisitionDiagnostic(
  text: string,
  kind: "native" | "fixture",
): Record<string, unknown> | undefined {
  try {
    if (text.length > 4096) return;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    const schema = kind === "native" ? nativeSchema : fixtureSchema;
    const expected = Object.keys(schema).length + (kind === "native" ? 2 : 1);
    if (Object.keys(input).length !== expected || input.schemaVersion !== 1)
      return;
    if (kind === "native" && input.kind !== "zenx-uia-acquisition") return;
    const result: Record<string, unknown> = { schemaVersion: 1 };
    for (const [key, rule] of Object.entries(schema)) {
      const field = input[key];
      if (
        rule === "bool"
          ? typeof field !== "boolean"
          : rule === "hresult"
            ? typeof field !== "string" || !/^h[0-9a-f]{8}$/u.test(field)
            : typeof field !== "string" || !rule.includes(field)
      )
        return;
      result[key] = field;
    }
    return result;
  } catch {
    return;
  }
}
/** All read/parse/sink failures are isolated from the original smoke exception. */
export async function reportAcquisitionFailure(options: {
  enabled: boolean;
  native: Record<string, unknown> | undefined;
  readFixture: () => Promise<string>;
  emit: (text: string) => void;
}): Promise<void> {
  if (!options.enabled) return;
  try {
    let fixture: Record<string, unknown> | undefined;
    try {
      fixture = parseAcquisitionDiagnostic(
        await options.readFixture(),
        "fixture",
      );
    } catch {
      /* unavailable */
    }
    options.emit(
      JSON.stringify({
        kind: "zenx-uia-acquisition-summary",
        native: options.native ?? "unavailable",
        fixture: fixture ?? "unavailable",
      }),
    );
  } catch {
    /* Diagnostics cannot replace the original exception. */
  }
}

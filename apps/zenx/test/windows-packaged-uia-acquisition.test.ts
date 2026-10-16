import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAcquisitionDiagnostic,
  reportAcquisitionFailure,
} from "../src/main/windows-packaged-uia-acquisition.js";
const native = {
  kind: "zenx-uia-acquisition",
  schemaVersion: 1,
  beforeApartment: "unavailable",
  afterApartment: "mta",
  beforeApartmentHresult: "h800401f0",
  afterApartmentHresult: "h00000000",
  connectionBudget: "default",
  transactionBudget: "nondefault",
  autoFocus: "disabled",
  ownerBefore: "matched",
  ownerAfter: "matched",
  outcome: "threw",
  errorCategory: "com",
  hresult: "h80131505",
  sameClientThread: true,
  observerFailed: false,
};
test("native diagnostic accepts only exact categorical schema", () => {
  assert.equal(
    parseAcquisitionDiagnostic(JSON.stringify(native), "native")?.hresult,
    "h80131505",
  );
  for (const value of [
    { ...native, pid: 12345 },
    { ...native, connectionBudget: 2000 },
    { ...native, hresult: "private error message" },
    { ...native, ownerBefore: "12345" },
    { ...native, sameClientThread: 1 },
    { ...native, schemaVersion: 2 },
  ])
    assert.equal(
      parseAcquisitionDiagnostic(JSON.stringify(value), "native"),
      undefined,
    );
  for (const text of ["invalid", "null", "[]", " ".repeat(4097)])
    assert.equal(parseAcquisitionDiagnostic(text, "native"), undefined);
});
test("disabled diagnostics perform no read or write", async () => {
  await reportAcquisitionFailure({
    enabled: false,
    native: undefined,
    readFixture: async () => {
      assert.fail("unexpected read");
    },
    emit: () => assert.fail("unexpected emit"),
  });
});
test("missing or untrusted fixture emits unavailable without leaking source", async () => {
  for (const readFixture of [
    async () => {
      throw new Error("private path");
    },
    async () => '{"pid":12345}',
  ]) {
    let output = "";
    await reportAcquisitionFailure({
      enabled: true,
      native: parseAcquisitionDiagnostic(JSON.stringify(native), "native"),
      readFixture,
      emit: (text) => {
        output = text;
      },
    });
    assert.equal(JSON.parse(output).fixture, "unavailable");
    assert.doesNotMatch(output, /private|12345/u);
  }
});
test("diagnostic sink fault cannot replace original failure", async () => {
  const original = new Error("original acquisition failure");
  await assert.rejects(
    async () => {
      try {
        throw original;
      } catch (error) {
        await reportAcquisitionFailure({
          enabled: true,
          native: undefined,
          readFixture: async () => "bad",
          emit: () => {
            throw new Error("sink fault");
          },
        });
        throw error;
      }
    },
    (error) => error === original,
  );
});

test("fixture schema rejects identities and preserves only observed booleans", () => {
  const fixture = Object.fromEntries(
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
    ].map((key) => [key, false]),
  );
  const receipt = { schemaVersion: 1, ...fixture, readyDispatched: true };
  assert.equal(
    parseAcquisitionDiagnostic(JSON.stringify(receipt), "fixture")
      ?.readyDispatched,
    true,
  );
  assert.equal(
    parseAcquisitionDiagnostic(
      JSON.stringify({ ...receipt, pid: 12345 }),
      "fixture",
    ),
    undefined,
  );
  assert.equal(
    parseAcquisitionDiagnostic(
      JSON.stringify({ ...receipt, uiaRootEntered: "true" }),
      "fixture",
    ),
    undefined,
  );
});

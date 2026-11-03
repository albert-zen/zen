import assert from "node:assert/strict";
import test from "node:test";
import { nativePointerRefusal } from "./native-pointer-refusal.js";

test("AX pointer refusal retains lookup statuses separately from an observed PID", () => {
  const prefix =
    "Global accessibility pointer recipient is not the selected application";
  const suffix = "; no input dispatched";
  assert.deepEqual(
    nativePointerRefusal(
      `${prefix} (point=170.0,633.0, selectedPID=2187, axHitStatus=0, axPIDStatus=0, hitPID=2193)${suffix}`,
    ),
    {
      point: { x: 170, y: 633 },
      selectedPID: 2187,
      axHitStatus: 0,
      axPIDStatus: 0,
      hitPID: 2193,
    },
  );
  assert.deepEqual(
    nativePointerRefusal(
      `${prefix} (point=-700.5,500.25, selectedPID=2187, axHitStatus=0, axPIDStatus=-25204, hitPID=0)${suffix}`,
    ),
    {
      point: { x: -700.5, y: 500.25 },
      selectedPID: 2187,
      axHitStatus: 0,
      axPIDStatus: -25204,
      hitPID: 0,
    },
  );
  assert.deepEqual(
    nativePointerRefusal(
      "Global accessibility pointer recipient is unavailable (point=170.0,633.0, selectedPID=2187, axHitStatus=-25202, axPIDStatus=not_queried, hitPID=unknown); no input dispatched",
    ),
    {
      point: { x: 170, y: 633 },
      selectedPID: 2187,
      axHitStatus: -25202,
      axPIDStatus: undefined,
      hitPID: undefined,
    },
  );
});

test("legacy CG refusal coordinates remain supplemental evidence", () => {
  assert.deepEqual(
    nativePointerRefusal(
      "Pointer blocked (occluderPID=43, point=-2.5,6, occluderBounds=0,0,10,10); no input dispatched",
    ),
    {
      point: { x: -2.5, y: 6 },
      legacyOccluderPID: 43,
    },
  );
});

test("missing, nonfinite and malformed native diagnostics do not infer a recipient", () => {
  for (const text of [
    "Global accessibility pointer recipient is not the selected application; no input dispatched",
    "(point=NaN,633, selectedPID=2187, axHitStatus=0, axPIDStatus=0, hitPID=2193)",
    "(point=170,Infinity, selectedPID=2187, axHitStatus=0, axPIDStatus=0, hitPID=2193)",
    "(point=170,633, selectedPID=2187, axHitStatus=0, axPIDStatus=0, hitPID=9007199254740992)",
    "(point=170,633, selectedPID=0, axHitStatus=0, axPIDStatus=0, hitPID=2193)",
  ])
    assert.equal(nativePointerRefusal(text), undefined, text);
});

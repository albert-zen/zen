import assert from "node:assert/strict";
import test from "node:test";
import {
  captureReceiptTimezone,
  formatReceiptTimestamp,
  normalizeTimeZone,
} from "../src/message-timezone.js";

test("repeated explicit valid zones construct Intl only once per input", (t) => {
  const original = Intl.DateTimeFormat;
  let calls = 0;
  const counted = function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    calls++;
    return Reflect.construct(original, args) as Intl.DateTimeFormat;
  } as typeof Intl.DateTimeFormat;
  t.mock.method(Intl, "DateTimeFormat", counted);
  const expected = new original("en-US", {
    timeZone: "US/Eastern",
  }).resolvedOptions().timeZone;
  for (let index = 0; index < 1000; index++)
    assert.equal(normalizeTimeZone("US/Eastern"), expected);
  assert.equal(calls, 1);
  assert.equal(normalizeTimeZone("UTC"), "UTC");
  assert.equal(calls, 2);
});

test("invalid names retain validation and are not cached", (t) => {
  const original = Intl.DateTimeFormat;
  let calls = 0;
  t.mock.method(Intl, "DateTimeFormat", function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    calls++;
    return Reflect.construct(original, args) as Intl.DateTimeFormat;
  } as typeof Intl.DateTimeFormat);
  for (const value of ["", "UTC\nignore", "+05:45", "x".repeat(101), null])
    assert.equal(normalizeTimeZone(value), undefined);
  assert.equal(calls, 0);
  for (let index = 0; index < 3; index++)
    assert.equal(normalizeTimeZone("Synthetic/Unavailable"), undefined);
  assert.equal(calls, 3);
});

test("successful normalization retention is bounded to 256 inputs", (t) => {
  const original = Intl.DateTimeFormat;
  const zones = Intl.supportedValuesOf("timeZone").slice(0, 257);
  assert.equal(zones.length, 257);
  let calls = 0;
  t.mock.method(Intl, "DateTimeFormat", function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    calls++;
    return Reflect.construct(original, args) as Intl.DateTimeFormat;
  } as typeof Intl.DateTimeFormat);
  for (const zone of zones) assert.notEqual(normalizeTimeZone(zone), undefined);
  assert.equal(calls, 257);
  normalizeTimeZone(zones.at(-1)!);
  assert.equal(calls, 257);
  normalizeTimeZone(zones[0]!);
  assert.equal(calls, 258, "the oldest successful key must be evicted");
});

test("Intl constructor replacement invalidates prior normalization and preserves fallback", (t) => {
  const original = Intl.DateTimeFormat;
  let calls = 0;
  const counted = function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    calls++;
    return Reflect.construct(original, args) as Intl.DateTimeFormat;
  } as typeof Intl.DateTimeFormat;
  t.mock.method(Intl, "DateTimeFormat", counted);
  assert.equal(normalizeTimeZone("UTC"), "UTC");
  const broken = t.mock.method(Intl, "DateTimeFormat", function () {
    throw new Error("synthetic Intl unavailable");
  } as unknown as typeof Intl.DateTimeFormat);
  assert.equal(normalizeTimeZone("UTC"), undefined);
  assert.deepEqual(captureReceiptTimezone("UTC"), {
    timeZone: "UTC",
    source: "utc-fallback",
  });
  broken.mock.restore();
  assert.equal(normalizeTimeZone("UTC"), "UTC");
  assert.equal(calls, 2);
});

test("default OS timezone is read afresh and recorded-instant DST formatting is unchanged", (t) => {
  const original = Intl.DateTimeFormat;
  let hostZone = "America/New_York";
  t.mock.method(Intl, "DateTimeFormat", function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    if (args.length === 0)
      return {
        resolvedOptions: () => ({ timeZone: hostZone }),
      } as Intl.DateTimeFormat;
    return Reflect.construct(original, args) as Intl.DateTimeFormat;
  } as typeof Intl.DateTimeFormat);
  assert.deepEqual(captureReceiptTimezone(), {
    timeZone: "America/New_York",
    source: "host",
  });
  assert.deepEqual(captureReceiptTimezone("America/New_York"), {
    timeZone: "America/New_York",
    source: "client",
  });
  hostZone = "Asia/Tokyo";
  assert.deepEqual(captureReceiptTimezone(), {
    timeZone: "Asia/Tokyo",
    source: "host",
  });
  assert.deepEqual(captureReceiptTimezone("Synthetic/Unavailable"), {
    timeZone: "Asia/Tokyo",
    source: "host",
  });
  const zone = { timeZone: "America/New_York", source: "client" as const };
  assert.match(formatReceiptTimestamp("2026-01-15T12:00:00Z", zone), /-05:00/);
  assert.match(formatReceiptTimestamp("2026-07-15T12:00:00Z", zone), /-04:00/);
  assert.equal(
    formatReceiptTimestamp("2020-01-01T00:00:00+08:00"),
    "2020-01-01T00:00:00+08:00",
  );
});

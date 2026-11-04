import assert from "node:assert/strict";
import test from "node:test";
import { formatCompletedAt } from "../src/renderer/src/completed-at.js";

function original(seconds: number, locale?: string): string {
  const completed = new Date(seconds * 1_000);
  const now = new Date();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(completed);
  if (
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate()
  )
    return time;
  const date = new Intl.DateTimeFormat(
    locale,
    completed.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(completed);
  return `${date} ${time}`;
}

function dates() {
  const today = new Date();
  today.setHours(12, 34, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const previousYear = new Date(today);
  previousYear.setFullYear(previousYear.getFullYear() - 1);
  const sameYearDay = new Date(today);
  sameYearDay.setDate(today.getDate() === 1 ? 2 : 1);
  return [today, yesterday, previousYear, sameYearDay].map(
    (date) => date.getTime() / 1_000,
  );
}

test("completion timestamps preserve today's, previous days' and previous years' local output", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of [
      "UTC",
      "America/New_York",
      "Asia/Kathmandu",
      "Pacific/Auckland",
    ]) {
      process.env.TZ = zone;
      for (const locale of [
        undefined,
        "en",
        "zh-CN",
        "ar-EG",
        "ja-JP-u-ca-japanese",
      ]) {
        for (const seconds of [
          ...dates(),
          0,
          Date.UTC(2026, 0, 15) / 1_000,
          Date.UTC(2026, 6, 15) / 1_000,
        ]) {
          assert.equal(
            formatCompletedAt(seconds, locale),
            original(seconds, locale),
          );
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("completion formatting resolves a changed OS timezone without stale cached output", () => {
  const previous = process.env.TZ;
  try {
    const seconds = Date.UTC(2025, 0, 15, 2, 34) / 1_000;
    process.env.TZ = "UTC";
    const utc = formatCompletedAt(seconds, "en");
    process.env.TZ = "America/New_York";
    const newYork = formatCompletedAt(seconds, "en");
    assert.equal(newYork, original(seconds, "en"));
    assert.notEqual(newYork, utc);
    process.env.TZ = "Asia/Kathmandu";
    assert.equal(formatCompletedAt(seconds, "en"), original(seconds, "en"));
    process.env.TZ = "UTC";
    assert.equal(formatCompletedAt(seconds, "en"), utc);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("completion formatting preserves invalid timestamp and locale errors", () => {
  for (const seconds of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.throws(() => original(seconds, "en"), RangeError);
    assert.throws(() => formatCompletedAt(seconds, "en"), RangeError);
  }
  assert.throws(() => formatCompletedAt(0, "not_a_locale"), RangeError);
});

test("full-history formatting reuses only three presentation formatters while probing current defaults", () => {
  const Real = Intl.DateTimeFormat;
  const calls: (Intl.DateTimeFormatOptions | undefined)[] = [];
  Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      calls.push(args[1]);
      return Reflect.construct(target, args);
    },
  });
  try {
    const values = dates();
    for (let index = 0; index < 10006; index++) {
      formatCompletedAt(values[index % values.length]!, "en");
    }
    assert.equal(calls.filter((options) => options?.hour).length, 1);
    assert.equal(calls.filter((options) => options?.month).length, 2);
    assert.equal(calls.filter((options) => !options).length, 10006);
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

test("formatter reuse is bounded to the current locale and constructor", () => {
  const Real = Intl.DateTimeFormat;
  let presentations = 0;
  Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      if (args[1]?.hour) presentations++;
      return Reflect.construct(target, args);
    },
  });
  try {
    const seconds = dates()[0]!;
    for (const locale of ["en", "en", "zh-CN", "zh-CN", "en", "en"]) {
      formatCompletedAt(seconds, locale);
    }
    assert.equal(
      presentations,
      3,
      "returning to an older locale recreates, rather than retaining an unbounded map",
    );
    Intl.DateTimeFormat = new Proxy(Real, {
      construct(target, args) {
        if (args[1]?.hour) presentations++;
        return Reflect.construct(target, args);
      },
    });
    formatCompletedAt(seconds, "en");
    assert.equal(presentations, 4);
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

test("an omitted locale follows changes to the current system default locale", () => {
  const Real = Intl.DateTimeFormat;
  let language = "en-US";
  Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      return Reflect.construct(target, [args[0] ?? language, args[1]]);
    },
  });
  try {
    const seconds = dates()[2]!;
    const english = formatCompletedAt(seconds);
    assert.equal(english, original(seconds));
    language = "zh-CN";
    const chinese = formatCompletedAt(seconds);
    assert.equal(chinese, original(seconds));
    assert.notEqual(chinese, english);
    language = "en-US";
    assert.equal(formatCompletedAt(seconds), english);
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

test("POSIX offset timezone defaults retain native formatting across zone changes", () => {
  const previous = process.env.TZ;
  try {
    const seconds = Date.UTC(2025, 0, 15, 2, 34) / 1_000;
    const expected: string[] = [];
    const actual: string[] = [];
    for (const zone of ["GMT+03", "GMT+04", "GMT-03", "GMT-04"]) {
      process.env.TZ = zone;
      expected.push(original(seconds, "en"));
      actual.push(formatCompletedAt(seconds, "en"));
    }
    assert.deepEqual(actual, expected);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("an unsupported explicit locale follows changes to the default fallback locale", () => {
  const Real = Intl.DateTimeFormat;
  let language = "en-US";
  Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) {
      const locale = args[0];
      return Reflect.construct(target, [
        locale === undefined || Real.supportedLocalesOf(locale).length === 0
          ? language
          : locale,
        args[1],
      ]);
    },
  });
  try {
    const seconds = Date.UTC(2025, 0, 15, 2, 34) / 1_000;
    const english = formatCompletedAt(seconds, "zz");
    assert.equal(english, original(seconds, "zz"));
    language = "zh-CN";
    const chinese = formatCompletedAt(seconds, "zz");
    assert.equal(chinese, original(seconds, "zz"));
    assert.notEqual(chinese, english);
    language = "en-US";
    assert.equal(formatCompletedAt(seconds, "zz"), english);
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

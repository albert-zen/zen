let cached:
  | {
      implementation: typeof Intl.DateTimeFormat;
      locale: string;
      defaultLocale: string;
      timeZone: string;
      time: Intl.DateTimeFormat;
      date?: Intl.DateTimeFormat;
      yearDate?: Intl.DateTimeFormat;
    }
  | undefined;

/** Local completion timestamp presentation shared by the message controls. */
export function formatCompletedAt(seconds: number, locale?: string): string {
  const completed = new Date(seconds * 1_000);
  const now = new Date();
  // Resolve current OS defaults on every call: a formatter must not retain an
  // old timezone after a system change. Only the three presentation formats are
  // reused, with one bounded entry rather than a cache per locale or message.
  // Default-zone names are invalidation keys, not explicit options: some POSIX
  // zones do not round-trip through resolvedOptions().timeZone.
  const constructor = Intl.DateTimeFormat;
  const defaults = new constructor().resolvedOptions();
  const language = locale ?? defaults.locale;
  const timeZone = defaults.timeZone;
  if (
    !cached ||
    cached.implementation !== constructor ||
    cached.locale !== language ||
    cached.defaultLocale !== defaults.locale ||
    cached.timeZone !== timeZone
  ) {
    cached = {
      implementation: constructor,
      locale: language,
      defaultLocale: defaults.locale,
      timeZone,
      time: new constructor(language, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    };
  }
  const time = cached.time.format(completed);
  if (
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate()
  ) {
    return time;
  }
  const sameYear = completed.getFullYear() === now.getFullYear();
  const key = sameYear ? "date" : "yearDate";
  const date = (cached[key] ??= new constructor(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
  })).format(completed);
  return `${date} ${time}`;
}

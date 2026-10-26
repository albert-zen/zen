import assert from "node:assert/strict";

/** Assertions for synthetic usage only; never scan arbitrary transcript text. */
export function assertOutputUsageObservation(observation, lang) {
  const contextWindow = new Intl.NumberFormat(lang, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(32_000);
  assert.match(observation.message, /900/u);
  assert.match(observation.message, /50%/u);
  assert.ok(
    observation.panel.includes(contextWindow),
    `Expected localized context window ${contextWindow}: ${observation.panel}`,
  );
  assert.match(observation.panel, /50%/u);
  assert.match(
    observation.header,
    lang === "en" ? /Worked for 3s/u : /已工作 3 秒/u,
  );
  assert.doesNotMatch(
    [
      observation.message,
      observation.title,
      observation.panel,
      observation.contextLabel,
      observation.header,
    ].join("\n"),
    /tok\/s|output speed unknown|输出速度未知/u,
  );
  assert.equal(observation.overflow, false);
}

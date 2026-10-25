import assert from "node:assert/strict";
import test from "node:test";
import { assertOutputUsageObservation } from "../scripts/output-usage-preview-assertions.mjs";

function observation(lang) {
  return {
    message: "input 1K · output 900 · cache 50%",
    title: "Turn cache telemetry",
    panel:
      lang === "en"
        ? "1K / 32K tokens · Thread cache 50%"
        : "1000 / 3.2万 tokens · 缓存 50%",
    contextLabel: "Context details",
    header: lang === "en" ? "Worked for 3s" : "已工作 3 秒",
    overflow: false,
    transcript: "The user can discuss TPS or output speed unknown freely.",
  };
}

test("output usage capture accepts localized context window and keeps factual assertions", () => {
  for (const lang of ["en", "zh-CN"]) {
    const value = observation(lang);
    assert.doesNotThrow(() => assertOutputUsageObservation(value, lang));
    for (const change of [
      { message: "output 899 · cache 50%" },
      { panel: "context 0 · cache 50%" },
      { panel: value.panel.replace("50%", "49%") },
      { header: "Worked for 4s" },
      { overflow: true },
      { title: "Turn cache telemetry · output 300 tok/s" },
      { contextLabel: "Context · 输出速度未知" },
      { header: `${value.header} · output 300 tok/s` },
    ]) {
      assert.throws(() =>
        assertOutputUsageObservation({ ...value, ...change }, lang),
      );
    }
  }
  assert.throws(() =>
    assertOutputUsageObservation(
      { ...observation("zh-CN"), panel: observation("en").panel },
      "zh-CN",
    ),
  );
  assert.throws(() =>
    assertOutputUsageObservation(
      { ...observation("en"), panel: observation("zh-CN").panel },
      "en",
    ),
  );
});

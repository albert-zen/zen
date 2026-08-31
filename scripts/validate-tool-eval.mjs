import { readFile } from "node:fs/promises";

const profiles = new Set([
  "shell_only",
  "generic_exact_replace",
  "vendor_native",
]);
const requiredMetricNames = [
  "completed",
  "firstEditAttemptSucceeded",
  "unintendedChanges",
  "schemaValidCalls",
  "schemaInvalidCalls",
  "toolCalls",
  "modelTurns",
  "inputTokens",
  "outputTokens",
  "elapsedMs",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const cases = await readJson(
  new URL("../docs/tool-eval-cases.json", import.meta.url),
);
const schema = await readJson(
  new URL("../docs/tool-eval-result.schema.json", import.meta.url),
);

assert(cases.version === 1, "tool eval cases must use version 1");
assert(
  JSON.stringify(cases.profiles) === JSON.stringify([...profiles]),
  "tool eval profiles do not match the result schema",
);
assert(
  Array.isArray(cases.cases) && cases.cases.length >= 8,
  "expected at least 8 cases",
);

const caseIds = new Set();
for (const item of cases.cases) {
  assert(
    typeof item.id === "string" && item.id.length > 0,
    "case id is required",
  );
  assert(!caseIds.has(item.id), `duplicate case id: ${item.id}`);
  caseIds.add(item.id);
  assert(
    typeof item.prompt === "string" && item.prompt.length > 0,
    `${item.id}: prompt is required`,
  );
  assert(
    item.setup && typeof item.setup === "object",
    `${item.id}: setup is required`,
  );
  assert(
    Array.isArray(item.checks) && item.checks.length > 0,
    `${item.id}: checks are required`,
  );
}

assert(
  schema.properties.profile.enum.every((profile) => profiles.has(profile)),
  "schema profiles differ from cases",
);
for (const metric of requiredMetricNames) {
  assert(
    schema.properties.metrics.required.includes(metric),
    `schema must require metric: ${metric}`,
  );
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function assertOnlyKeys(value, allowed, path) {
  assert(
    Object.keys(value).every((key) => allowed.has(key)),
    `${path}: unknown field`,
  );
}

function validateResult(result, path) {
  const allowedTopLevel = new Set(schema.required.concat("notes"));
  assert(
    result && typeof result === "object" && !Array.isArray(result),
    `${path}: result must be an object`,
  );
  assertOnlyKeys(result, allowedTopLevel, path);
  for (const field of schema.required) {
    assert(Object.hasOwn(result, field), `${path}: missing ${field}`);
  }
  assert(result.version === 1, `${path}: version must be 1`);
  assert(
    typeof result.runId === "string" && result.runId.length > 0,
    `${path}: runId is required`,
  );
  assert(
    caseIds.has(result.caseId),
    `${path}: unknown caseId ${result.caseId}`,
  );
  assert(
    profiles.has(result.profile),
    `${path}: unknown profile ${result.profile}`,
  );
  assert(
    Number.isInteger(result.repetition) && result.repetition >= 1,
    `${path}: repetition must be positive`,
  );
  assert(
    result.model &&
      typeof result.model.provider === "string" &&
      result.model.provider.length > 0,
    `${path}: model.provider is required`,
  );
  assertOnlyKeys(
    result.model,
    new Set(["provider", "modelId", "nativeContract"]),
    `${path}.model`,
  );
  assert(
    typeof result.model.modelId === "string" && result.model.modelId.length > 0,
    `${path}: model.modelId is required`,
  );
  if (result.profile === "vendor_native") {
    assert(
      typeof result.model.nativeContract === "string" &&
        result.model.nativeContract.length > 0,
      `${path}: vendor_native requires model.nativeContract`,
    );
  }
  assert(
    result.metrics && typeof result.metrics === "object",
    `${path}: metrics are required`,
  );
  assertOnlyKeys(
    result.metrics,
    new Set(requiredMetricNames),
    `${path}.metrics`,
  );
  for (const metric of requiredMetricNames) {
    assert(
      Object.hasOwn(result.metrics, metric),
      `${path}: missing metric ${metric}`,
    );
  }
  assert(
    typeof result.metrics.completed === "boolean",
    `${path}: completed must be boolean`,
  );
  assert(
    [true, false, null].includes(result.metrics.firstEditAttemptSucceeded),
    `${path}: invalid firstEditAttemptSucceeded`,
  );
  for (const metric of [
    "unintendedChanges",
    "schemaValidCalls",
    "schemaInvalidCalls",
    "toolCalls",
    "elapsedMs",
  ]) {
    assert(
      isNonNegativeInteger(result.metrics[metric]),
      `${path}: ${metric} must be non-negative`,
    );
  }
  for (const metric of ["inputTokens", "outputTokens"]) {
    assert(
      result.metrics[metric] === null ||
        isNonNegativeInteger(result.metrics[metric]),
      `${path}: ${metric} must be non-negative or null`,
    );
  }
  assert(
    Number.isInteger(result.metrics.modelTurns) &&
      result.metrics.modelTurns >= 1,
    `${path}: modelTurns must be positive`,
  );
  assert(
    Array.isArray(result.failureCodes) &&
      result.failureCodes.every(
        (code) => typeof code === "string" && code.length > 0,
      ),
    `${path}: failureCodes must be strings`,
  );
  assert(
    new Set(result.failureCodes).size === result.failureCodes.length,
    `${path}: failureCodes must be unique`,
  );
}

const resultPaths =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [new URL("../docs/tool-eval-result.example.json", import.meta.url)];

for (const path of resultPaths) validateResult(await readJson(path), path);

console.log(
  `Validated ${cases.cases.length} tool-eval cases and ${resultPaths.length} result file(s).`,
);

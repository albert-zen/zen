import { runDogfoodAcceptanceScenario } from "../../acceptance/dist/dogfood-acceptance.js";

const result = await runDogfoodAcceptanceScenario({
  configPath: process.env.ALB94_DOGFOOD_PROVIDER_CONFIG,
  evidencePath: process.env.ALB94_DOGFOOD_EVIDENCE,
  fixtureRoot: process.env.ALB94_DOGFOOD_FIXTURE_ROOT,
  timeoutMs: readOptionalInteger(process.env.ALB94_DOGFOOD_TIMEOUT_MS)
});

console.log(JSON.stringify(result, null, 2));

if (result.status === "failed") {
  process.exitCode = 1;
}

function readOptionalInteger(value) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`ALB94_DOGFOOD_TIMEOUT_MS must be a positive integer: ${value}`);
  }

  return parsed;
}

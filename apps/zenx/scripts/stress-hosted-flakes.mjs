import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const zenx = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const iterations = positiveInteger(
  process.env.ZENX_HOSTED_FLAKE_ITERATIONS,
  20,
  "ZENX_HOSTED_FLAKE_ITERATIONS",
);
const workers = Math.min(
  iterations,
  positiveInteger(
    process.env.ZENX_HOSTED_FLAKE_WORKERS,
    Math.min(2, availableParallelism()),
    "ZENX_HOSTED_FLAKE_WORKERS",
  ),
);
const testNamePattern = [
  "real ZenX host control tools make active semantics explicit",
  "stages the first meaningful input immediately, bounds it, then generates",
  "failure preserves the provisional title and explicit retry can generate",
  "an externally-originated completed userMessage starts staged naming once",
].join("|");
const testFiles = [
  "test/self-control-capability.test.ts",
  "test/thread-title-coordinator.test.ts",
  "test/thread-title-notification.test.ts",
].map((file) => path.join(zenx, file));

let nextIteration = 1;
let failure;

await Promise.all(
  Array.from({ length: workers }, (_, index) => runWorker(index + 1)),
);

if (failure === undefined) {
  console.log(
    `hosted-flake stress passed: ${String(iterations)} iterations across ${String(
      workers,
    )} workers`,
  );
} else {
  console.error(
    `hosted-flake stress failed: iteration ${String(
      failure.iteration,
    )} on worker ${String(failure.worker)} exited ${String(failure.exitCode)}`,
  );
  process.exitCode = 1;
}

async function runWorker(worker) {
  while (failure === undefined) {
    const iteration = nextIteration;
    nextIteration += 1;
    if (iteration > iterations) return;
    console.log(
      `hosted-flake stress iteration ${String(iteration)}/${String(
        iterations,
      )} (worker ${String(worker)})`,
    );
    const exitCode = await runFocusedTests();
    if (exitCode !== 0 && failure === undefined) {
      failure = { iteration, worker, exitCode };
    }
  }
}

async function runFocusedTests() {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsx,
        "--test",
        "--test-concurrency=1",
        "--test-name-pattern",
        testNamePattern,
        ...testFiles,
      ],
      { cwd: zenx, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`focused hosted-flake tests exited via ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function positiveInteger(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(
  new URL("../../../.github/workflows/information-board.yml", import.meta.url),
  "utf8",
);
const workflow = parse(source);
const job = workflow.jobs["native-information"];
const sdk = job.steps.find(
  (step) =>
    step.name ===
    "Select installed SDK for the unchanged production native helper",
);

test("information board uses a supported fixed x64 macOS image with truthful matrix receipts", () => {
  assert.deepEqual(job.strategy.matrix.os, [
    "windows-latest",
    "macos-15-intel",
  ]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.equal(job["timeout-minutes"], 18);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.ok(
    workflow.on.pull_request.paths.includes(
      ".github/workflows/information-board.yml",
    ),
  );
  assert.match(source, /no longer provides macOS 14 runtime coverage/);
  assert.equal(job.name, undefined);
  for (const step of job.steps)
    assert.equal(step["continue-on-error"], undefined);
  const uploads = job.steps.filter(
    (step) => step.uses === "actions/upload-artifact@v4",
  );
  assert.deepEqual(
    uploads.map((step) => step.with.name),
    [
      "pending-shelf-${{ matrix.os }}-${{ github.sha }}",
      "information-board-${{ matrix.os }}-${{ github.sha }}",
    ],
  );
  for (const step of uploads) {
    assert.equal(step.if, "always()");
    assert.equal(step.with["retention-days"], 14);
  }
  assert.equal(uploads[0].with["if-no-files-found"], "warn");
  assert.equal(uploads[1].with["if-no-files-found"], "error");
});

test("native information and pending-shelf acceptance commands, guards and budgets remain required", () => {
  assert.deepEqual(
    job.steps
      .filter((step) => step.run?.startsWith("npm "))
      .map((step) => step.run),
    ["npm ci", "npm run build", "npm run build --workspace @zen/zenx"],
  );
  const native = job.steps.find(
    (step) =>
      step.name ===
      "Native information board flow in disposable full production App",
  );
  assert.equal(
    native.run,
    'node apps/zenx/scripts/launch-information-board-acceptance.mjs "${{ runner.temp }}/information-board"',
  );
  assert.equal(native.if, undefined);
  assert.equal(native["timeout-minutes"], 6);
  const pending = job.steps.find(
    (step) =>
      step.name ===
      "Pending steer shelf and stable local echo in native component preview",
  );
  assert.equal(
    pending.run,
    'node apps/zenx/scripts/launch-pending-shelf-acceptance.mjs "${{ runner.temp }}/pending-shelf"',
  );
  assert.equal(pending.if, "${{ !cancelled() }}");
  assert.equal(pending["timeout-minutes"], 2);
  assert.ok(job.steps.indexOf(sdk) < job.steps.indexOf(native));
});

test("SDK selection is job-local and rejects unavailable, malformed or pre-15 SDKs", (t) => {
  assert.equal(sdk.if, "runner.os == 'macOS'");
  assert.equal(sdk.shell, "bash");
  assert.deepEqual(sdk.env, {
    DEVELOPER_DIR: "/Applications/Xcode_16.2.app/Contents/Developer",
  });
  assert.doesNotMatch(sdk.run, /sudo|xcode-select|softwareupdate/);
  assert.match(sdk.run, /xcrun --sdk macosx --show-sdk-version/);
  // Synthetic executable only: no native SDK, compiler or user machine is used.
  const cwd = mkdtempSync(join(tmpdir(), "information-sdk-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(
    join(cwd, "xcrun"),
    '#!/bin/sh\nprintf "%s\\n" "$MOCK_SDK"\nexit "${MOCK_STATUS:-0}"\n',
    { mode: 0o755 },
  );
  for (const [version, status, accepted] of [
    ["15.2", "0", true],
    ["15", "0", true],
    ["26.0", "0", true],
    ["14.5", "0", false],
    ["", "0", false],
    ["unknown", "0", false],
    ["15.bad", "0", false],
    ["15.2", "1", false],
  ]) {
    const envFile = join(cwd, "github-env");
    rmSync(envFile, { force: true });
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", sdk.run],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          ...sdk.env,
          PATH: `${cwd}:${process.env.PATH}`,
          MOCK_SDK: version,
          MOCK_STATUS: status,
          GITHUB_ENV: envFile,
        },
      },
    );
    assert.equal(
      result.status === 0,
      accepted,
      `${version}/${status}: ${result.stderr}`,
    );
    assert.equal(existsSync(envFile), accepted);
    if (accepted)
      assert.equal(
        readFileSync(envFile, "utf8"),
        `DEVELOPER_DIR=${sdk.env.DEVELOPER_DIR}\n`,
      );
  }
});

/** Public artifact allowlist. Raw browser diagnostics remain runner-local. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const names = ["initial", "cross-256", "oldest", "latest"];
const safeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
async function json(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}
export async function collectRoomHistoryEvidence(input, output, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw Error("A verified source commit is required");
  await mkdir(output, { recursive: true });
  const source = await json(path.join(input, "source.json"));
  const measured = await json(path.join(input, "measurements.json"));
  const lifecycle = await json(path.join(input, "browser-lifecycle.json"));
  let hashesValid = false;
  try {
    hashesValid =
      hex(source.htmlSha256) &&
      hex(source.fixtureSha256) &&
      sha(await readFile(path.join(input, "room-history.html"))) ===
        source.htmlSha256 &&
      sha(await readFile(path.join(input, "fixture.json"))) ===
        source.fixtureSha256;
  } catch {}
  const sourceValid =
    source.commit === commit &&
    hashesValid &&
    source.count === 320 &&
    source.finalCount === 320 &&
    source.dispatches === 0 &&
    source.restartVerified === true &&
    source.bodyBytes > 1024 * 1024;
  const screenshots = {};
  for (const name of names) {
    try {
      const bytes = await readFile(path.join(input, `${name}.png`));
      if (
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        continue;
      await writeFile(path.join(output, `${name}.png`), bytes);
      screenshots[name] = sha(bytes);
    } catch {}
  }
  const cases = names.map((name) => {
    const entry =
      measured.cases?.find((candidate) => candidate.name === name) ?? {};
    return {
      name,
      count: safeInteger(entry.count),
      unique: safeInteger(entry.unique),
      idsMatch: entry.idsMatch === true,
      textsMatch: entry.textsMatch === true,
      scrollStable: entry.scrollStable === true,
    };
  });
  const capturePassed =
    measured.status === "passed" &&
    measured.browserSandboxDisabled === false &&
    Array.isArray(measured.rendererErrors) &&
    measured.rendererErrors.length === 0 &&
    Array.isArray(measured.externalRequests) &&
    measured.externalRequests.length === 0 &&
    lifecycle.captureStatus === "passed" &&
    lifecycle.cleanupComplete === true &&
    lifecycle.artifactErrors?.length === 0 &&
    names.every((name) => screenshots[name]) &&
    cases.every(
      (entry) =>
        entry.idsMatch &&
        entry.textsMatch &&
        entry.scrollStable &&
        entry.count === entry.unique,
    ) &&
    cases[0].count === 4 &&
    cases[1].count > 256 &&
    cases[1].count <= 320 &&
    cases[2].count === 320 &&
    cases[3].count === 320;
  const receipt = {
    schemaVersion: 1,
    scope:
      "Synthetic production Room journal persistence/restart and production RoomsPage component capture; not native Electron acceptance.",
    commit,
    acceptancePassed: sourceValid && capturePassed,
    sourceVerified: sourceValid,
    capturePassed,
    fixtureSha256: sourceValid ? source.fixtureSha256 : null,
    htmlSha256: sourceValid ? source.htmlSha256 : null,
    node: /^v\d+\.\d+\.\d+$/.test(source.node ?? "") ? source.node : null,
    count: sourceValid ? 320 : null,
    bodyBytes: sourceValid ? safeInteger(source.bodyBytes) : null,
    dispatches: sourceValid ? 0 : null,
    lifecycle: {
      capturePassed: lifecycle.captureStatus === "passed",
      cleanupComplete: lifecycle.cleanupComplete === true,
    },
    screenshots,
    cases,
  };
  await writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const receipt = await collectRoomHistoryEvidence(
    path.resolve(process.argv[2]),
    path.resolve(process.argv[3]),
    process.argv[4] ?? process.env.GITHUB_SHA,
  );
  if (!receipt.acceptancePassed) process.exitCode = 1;
}

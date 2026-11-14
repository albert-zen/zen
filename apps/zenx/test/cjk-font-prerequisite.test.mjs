import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APT_OPTIONS,
  installPackage,
  officialArchive,
  resolvePackage,
  sourceArchives,
} from "../scripts/prepare-cjk-fonts.mjs";

const bytes = Buffer.from("synthetic public font archive; never installed");
const digest = createHash("sha256").update(bytes).digest("hex");
const source =
  "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-security\nComponents: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
const mirrors =
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
const targets = `Identifier: Packages
Origin: Ubuntu
Label: Ubuntu
Component: main
Architecture: amd64
Codename: noble
Release: noble
Trusted: yes
Filename: /synthetic/Packages
Repo-URI: mirror+file:/etc/apt/apt-mirrors.txt/
Sourcesentry: /etc/apt/sources.list.d/ubuntu.sources:1
`;
const record = `Package: fonts-noto-cjk
Version: 1:20230817+repack1-3
Architecture: all
Filename: pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817+repack1-3_all.deb
Size: ${bytes.length}
SHA256: ${digest}
`;
const input = {
  os: { ID: "ubuntu", VERSION_ID: "24.04", VERSION_CODENAME: "noble" },
  arch: "amd64",
  candidate: "1:20230817+repack1-3",
  targets,
  readIndex: () => record,
  readSource: (file) => (file.endsWith("apt-mirrors.txt") ? mirrors : source),
};
const metadata = () => resolvePackage(input);

function fixture(t, mode = "cold", transport = "success") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cjk-prerequisite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "cache", "fonts-noto-cjk.deb");
  if (mode !== "cold") {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      mode === "warm" ? bytes : Buffer.alloc(bytes.length, 0),
    );
  }
  const calls = [];
  const run = (program, args, seconds, privileged) => {
    calls.push({ program, args, seconds, privileged });
    if (program.endsWith("apt-helper")) {
      assert.equal(seconds, 45);
      assert.ok(args.includes(`SHA256:${digest}`));
      assert.ok(args.includes("Acquire::http::AllowRedirect=false"));
      assert.ok(args.includes("Acquire::https::AllowRedirect=false"));
      if (
        transport === "unavailable" ||
        (transport === "first-unavailable" && calls.length === 1)
      )
        throw Object.assign(new Error("synthetic unavailable"), {
          status: 124,
        });
      writeFileSync(
        args[args.indexOf("download-file") + 2],
        transport === "corrupt" ? Buffer.alloc(bytes.length, 0) : bytes,
      );
      return "synthetic download";
    }
    if (program === "apt-get") {
      assert.equal(privileged, true);
      assert.equal(seconds, 90);
      assert.deepEqual(readFileSync(file), bytes);
      assert.ok(args.includes("--no-download"));
      assert.ok(args.includes(`fonts-noto-cjk=${metadata().version}`));
      const archives = args
        .find((arg) => arg.startsWith("Dir::Cache::archives="))
        .slice("Dir::Cache::archives=".length);
      assert.ok(archives.startsWith(path.join(directory, "apt-archives-")));
      assert.deepEqual(
        readFileSync(
          path.join(archives, "fonts-noto-cjk_1%3a20230817+repack1-3_all.deb"),
        ),
        bytes,
      );
      assert.ok(!args.includes(file));
      return "synthetic normal apt install";
    }
    if (program === "dpkg-query") return metadata().version;
    if (program === "fc-list") return "Noto Sans CJK SC";
    assert.fail(`Unexpected command ${program}`);
  };
  return { directory, file, calls, run, current: metadata };
}

test("signed current Ubuntu record binds exact cache identity and existing archive priority", () => {
  const result = metadata();
  assert.equal(
    result.cacheKey,
    `zenx-cjk-deb-v1-ubuntu-24.04-noble-amd64-1:20230817+repack1-3-${digest}`,
  );
  assert.equal(result.archives[0], "https://archive.ubuntu.com/ubuntu/");
  assert.equal(result.archives.length, 3);
  assert.equal(result.sourceHash.length, 64);
  assert.ok(APT_OPTIONS.includes("Acquire::Retries=0"));
  assert.ok(APT_OPTIONS.includes("Acquire::http::Timeout=15"));
  assert.ok(APT_OPTIONS.includes("APT::Get::AllowUnauthenticated=false"));
});

test("cold miss downloads authenticated hash then installs normally and verifies fonts", (t) => {
  const f = fixture(t);
  installPackage(f.directory, metadata(), f);
  assert.deepEqual(
    f.calls.map((call) => path.basename(call.program)),
    ["apt-helper", "apt-get", "dpkg-query", "fc-list"],
  );
  assert.ok(
    f.calls[0].args.some((arg) =>
      arg.startsWith("https://archive.ubuntu.com/ubuntu/pool/"),
    ),
  );
});

test("warm cache is rehashed and normal APT installation forbids all downloads", (t) => {
  const f = fixture(t, "warm");
  installPackage(f.directory, metadata(), f);
  assert.deepEqual(
    f.calls.map((call) => call.program),
    ["apt-get", "dpkg-query", "fc-list"],
  );
});

test("corrupt warm cache fails closed without download or installation", (t) => {
  const f = fixture(t, "corrupt");
  assert.throws(
    () => installPackage(f.directory, metadata(), f),
    /SHA256 mismatch/,
  );
  assert.equal(f.calls.length, 0);
});

test("wrong-size and dangling-symlink cache entries fail before any transport", (t) => {
  const f = fixture(t, "warm");
  writeFileSync(f.file, "truncated");
  assert.throws(
    () => installPackage(f.directory, metadata(), f),
    /size mismatch/,
  );
  assert.equal(f.calls.length, 0);
  if (process.platform !== "win32") {
    rmSync(f.file);
    symlinkSync(path.join(f.directory, "absent"), f.file);
    assert.throws(
      () => installPackage(f.directory, metadata(), f),
      /regular file/,
    );
    assert.equal(f.calls.length, 0);
  }
});

test("successful transport with corrupt bytes fails closed without mirror fallback", (t) => {
  const f = fixture(t, "cold", "corrupt");
  assert.throws(
    () => installPackage(f.directory, metadata(), f),
    /SHA256 mismatch/,
  );
  assert.equal(f.calls.length, 1);
});

test("unavailable official mirrors stop after one bounded attempt per configured archive", (t) => {
  const f = fixture(t, "cold", "unavailable");
  assert.throws(
    () => installPackage(f.directory, metadata(), f),
    /All configured official/,
  );
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((call) => call.program.endsWith("apt-helper")));
});

test("a bounded transport failure may use only another originally configured official mirror", (t) => {
  const f = fixture(t, "cold", "first-unavailable");
  installPackage(f.directory, metadata(), f);
  assert.equal(
    f.calls.filter((call) => call.program.endsWith("apt-helper")).length,
    2,
  );
});

test("changed source or package identity cannot consume an old restored cache", (t) => {
  for (const changed of [
    { ...metadata(), sourceHash: "0".repeat(64) },
    { ...metadata(), sha256: "0".repeat(64) },
    { ...metadata(), version: "2:20230817+repack1-3" },
  ]) {
    const f = fixture(t, "warm");
    assert.throws(
      () => installPackage(f.directory, changed, f),
      /metadata changed/,
    );
    assert.equal(f.calls.length, 0);
  }
  const changedSource = resolvePackage({
    ...input,
    readSource: (file) =>
      file.endsWith("apt-mirrors.txt") ? mirrors : `${source}# changed\n`,
  });
  assert.notEqual(changedSource.sourceHash, metadata().sourceHash);
});

test("untrusted, wrong-release, wrong-version or missing-hash records fail closed", () => {
  for (const change of [
    { targets: targets.replace("Trusted: yes", "Trusted: no") },
    { targets: targets.replace("Codename: noble", "Codename: jammy") },
    { targets: targets.replace("Release: noble", "Release: jammy") },
    { targets: targets.replace("Origin: Ubuntu", "Origin: Other") },
    { readIndex: () => record.replace(digest, "") },
    { readIndex: () => record.replace("1:20230817", "2:20230817") },
    { readIndex: () => record.replace("pool/main/f/", "pool/main/../") },
    { readSource: () => "Trusted: yes\n" },
  ])
    assert.throws(() => resolvePackage({ ...input, ...change }));
});

test("unknown mirrors and URL authority/path escapes are never downloaded", () => {
  for (const uri of [
    "https://example.test/ubuntu/",
    "https://archive.ubuntu.com.evil.test/ubuntu/",
    "https://user@archive.ubuntu.com/ubuntu/",
    "https://archive.ubuntu.com:8443/ubuntu/",
    "https://archive.ubuntu.com/x/../ubuntu/",
    "https://archive.ubuntu.com/ubuntu/?x=1",
    "file:/etc/apt/apt-mirrors.txt",
    "https://archive.ubuntu.com/ubuntu/%2e%2e/",
  ])
    assert.throws(() => officialArchive(uri));
  assert.throws(() =>
    resolvePackage({
      ...input,
      readSource: (file) =>
        file.endsWith("apt-mirrors.txt")
          ? "https://unknown.test/ubuntu/"
          : source,
    }),
  );
});

test("offline APT dependency/installation failure is final, never retried online", (t) => {
  const f = fixture(t, "warm");
  const run = (...args) => {
    f.run(...args);
    if (args[0] === "apt-get")
      throw new Error("synthetic offline dependency unavailable");
    return "";
  };
  assert.throws(
    () => installPackage(f.directory, metadata(), { ...f, run }),
    /offline dependency unavailable/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.program),
    ["apt-get"],
  );
});

test("font absence or wrong installed version remains a failure", (t) => {
  for (const brokenCommand of ["fc-list", "dpkg-query"]) {
    const f = fixture(t, "warm");
    const run = (...args) => (args[0] === brokenCommand ? "" : f.run(...args));
    assert.throws(() => installPackage(f.directory, metadata(), { ...f, run }));
  }
});

test("workflow prepares fonts before every capture and never caches apt state", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const zenx = workflow.split("  zenx-ui:\n")[1].split("  zenx:\n")[0];
  // Keep the existing workload budget. Room screenshots are one-time evidence,
  // not an additional capture on every unrelated change.
  assert.ok(zenx.includes("timeout-minutes: 32"));
  const tabCapture = zenx
    .split("      - ")
    .find((step) =>
      step.startsWith(
        "name: Verify workspace tab overflow on production components",
      ),
    );
  assert.ok(tabCapture?.includes("timeout-minutes: 6"));

  assert.ok(
    zenx.indexOf("id: zenx-fonts") <
      zenx.indexOf("capture-titlebar-safe-area-preview.mjs"),
  );
  assert.ok(zenx.includes("path: ${{ steps.cjk-package.outputs.deb-path }}"));
  assert.ok(!zenx.includes("restore-keys:"));
  for (const step of zenx.split("      - ")) {
    if (step.includes("capture-") && step.includes("if:"))
      assert.ok(step.includes("steps.zenx-fonts.outcome == 'success'"));
  }
  for (const script of [
    "capture-whats-new-preview.mjs",
    "capture-trigger-message-preview.mjs",
    "capture-file-sidebar-preview.mjs",
    "capture-settings-audit-preview.mjs",
    "capture-room-history-preview.mjs",
  ]) {
    const code = readFileSync(
      new URL(`../scripts/${script}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      code.includes('"fc-list"') &&
        code.includes("evidence.cjkFonts.length > 0"),
    );
  }
});

test("rejected mirror records its physical line and bounded identity without secrets", () => {
  const messages = [];
  const list =
    "# public comment\n\nhttps://archive.ubuntu.com/ubuntu/\nhttps://USER_SECRET:PASS_SECRET@unknown.test:8443/PRIVATE_PATH?QUERY_SECRET#FRAGMENT_SECRET priority:1\n";
  assert.throws(
    () =>
      sourceArchives(
        {
          "repo-uri": "mirror+file:/etc/apt/apt-mirrors.txt/",
          sourcesentry: "/etc/apt/sources.list.d/ubuntu.sources:1",
        },
        (file) => (file.endsWith("apt-mirrors.txt") ? list : source),
        (message) => messages.push(message),
      ),
    /Unconfigured or nonofficial Ubuntu host/,
  );
  assert.equal(messages.length, 1);
  const diagnostic = JSON.parse(
    messages[0].slice("CJK archive rejected: ".length),
  );
  assert.deepEqual(diagnostic, {
    phase: "mirror-list",
    line: 4,
    parsed: true,
    protocol: "https:",
    hostname: "unknown.test",
    port: "8443",
    credentialsPresent: true,
    queryPresent: true,
    fragmentPresent: true,
  });
  assert.doesNotMatch(messages[0], /SECRET|PRIVATE_PATH|priority/);
  assert.ok(messages[0].length < 600);
});

test("direct source rejection preserves its source line and original assertion", () => {
  const messages = [];
  assert.throws(
    () =>
      sourceArchives(
        {
          "repo-uri": "https://archive.ubuntu.com/PRIVATE_PATH",
          sourcesentry: "/etc/apt/sources.list:7",
        },
        () => source,
        (message) => messages.push(message),
      ),
    /Unexpected Ubuntu archive path/,
  );
  const diagnostic = JSON.parse(
    messages[0].slice("CJK archive rejected: ".length),
  );
  assert.equal(diagnostic.phase, "repo-uri");
  assert.equal(diagnostic.line, 7);
  assert.equal(diagnostic.hostname, "archive.ubuntu.com");
  assert.doesNotMatch(messages[0], /PRIVATE_PATH/);
});

test("malformed or oversized URL diagnostics are bounded and a broken sink cannot accept", () => {
  for (const value of [
    "SECRET_NOT_A_URL",
    `https://${"a".repeat(3000)}.test/SECRET_PATH`,
  ]) {
    const messages = [];
    assert.throws(() =>
      sourceArchives(
        { "repo-uri": value, sourcesentry: "/etc/apt/sources.list:1" },
        () => source,
        (message) => messages.push(message),
      ),
    );
    assert.equal(messages.length, 1);
    assert.ok(messages[0].length < 600);
    assert.doesNotMatch(messages[0], /SECRET/);
  }
  assert.throws(
    () =>
      sourceArchives(
        {
          "repo-uri": "https://unknown.test/ubuntu/",
          sourcesentry: "/etc/apt/sources.list:1",
        },
        () => source,
        () => {
          throw new Error("synthetic diagnostic sink failure");
        },
      ),
    /Unconfigured or nonofficial Ubuntu host/,
  );
});

test("allowed mirrors preserve source identity and emit no rejection diagnostic", () => {
  const messages = [];
  const target = {
    "repo-uri": "mirror+file:/etc/apt/apt-mirrors.txt/",
    sourcesentry: "/etc/apt/sources.list.d/ubuntu.sources:1",
  };
  const result = sourceArchives(target, input.readSource, (message) =>
    messages.push(message),
  );
  assert.equal(
    result.sourceHash,
    createHash("sha256")
      .update(
        JSON.stringify([
          "/etc/apt/sources.list.d/ubuntu.sources",
          source,
          target["repo-uri"],
          mirrors,
        ]),
      )
      .digest("hex"),
  );
  assert.deepEqual(result.archives, metadata().archives);
  assert.deepEqual(messages, []);
});

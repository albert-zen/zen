import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

async function main() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-browser-persistence-"),
  );
  let cleanupSafe = true;
  const profile = path.join(root, "profile");
  const fixture = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/login") {
      response.setHeader("Set-Cookie", [
        "fixture_persistent=present; Path=/; Max-Age=3600; SameSite=Lax",
        "fixture_session=present; Path=/; SameSite=Lax",
      ]);
      response.end(`<!doctype html><title>Synthetic login fixture</title>
      <script>localStorage.setItem('fixture-local','present');
      sessionStorage.setItem('fixture-tab','present');</script>`);
    } else {
      response.end(
        "<!doctype html><title>Synthetic storage inspection</title>",
      );
    }
  });

  try {
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const results = [];
    for (const phase of ["write", "read"]) {
      const environment = {
        ...process.env,
        ZENX_BROWSER_PERSISTENCE_PROFILE: profile,
        ZENX_BROWSER_PERSISTENCE_ORIGIN: origin,
        ZENX_BROWSER_PERSISTENCE_PHASE: phase,
      };
      delete environment.ELECTRON_RUN_AS_NODE;
      const entry = fileURLToPath(
        new URL(
          "../out/main/workspace-browser-persistence-smoke.js",
          import.meta.url,
        ),
      );
      const executable =
        typeof electron === "string" ? electron : process.execPath;
      const child = spawn(executable, [entry, `--user-data-dir=${profile}`], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.pipe(process.stderr);
      let code;
      try {
        code = await waitForSmokeProcess(child);
      } catch (error) {
        cleanupSafe = error.reaped !== false;
        throw error;
      }
      assert.equal(code, 0, `${phase} Electron process failed`);
      const resultLine = output
        .split("\n")
        .find((line) => line.startsWith("ZENX_BROWSER_PERSISTENCE_RESULT "));
      assert.ok(resultLine, `${phase} process did not report a result`);
      results.push(JSON.parse(resultLine.split(" ").slice(1).join(" ")));
    }
    assert.notEqual(results[0].pid, results[1].pid);
    assert.equal(results[0].storagePath, results[1].storagePath);
    console.log(
      "PASS: fresh Electron processes reused the synthetic Workspace browser profile.",
    );
  } finally {
    await new Promise((resolve) => fixture.close(resolve));
    if (cleanupSafe) await rm(root, { recursive: true, force: true });
    else console.error(`Retained unreaped fixture profile: ${root}`);
  }
}

/** Bound both the smoke and signal escalation; never delete a live profile. */
export async function waitForSmokeProcess(
  child,
  timeoutMs = 30_000,
  graceMs = 3_000,
) {
  let reaped = false;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => {
      reaped = true;
      resolve({ code });
    });
  });
  const within = async (ms) => {
    let timer;
    try {
      return await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Electron smoke timed out")),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const result = await within(timeoutMs);
    if (result.error) throw result.error;
    return result.code;
  } catch (error) {
    if (!reaped && child.pid !== undefined) {
      child.kill("SIGTERM");
      try {
        await within(graceMs);
      } catch {
        child.kill("SIGKILL");
        await within(graceMs).catch(() => undefined);
      }
    }
    // A failed spawn owns no running process. If reap itself failed, stop the
    // harness hanging on pipes, retain its profile, and report uncertainty.
    error.reaped = reaped || child.pid === undefined;
    if (!error.reaped) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

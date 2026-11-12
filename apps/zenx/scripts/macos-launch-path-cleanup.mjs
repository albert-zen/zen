import { execFile } from "node:child_process";
import { readFile, readlink, realpath } from "node:fs/promises";
import net from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read-only identity checks. No caller of this module signals a numeric PID.
export async function nativeProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid owned PID");
  try {
    if (process.platform === "linux") {
      const base = `/proc/${pid}`;
      const stat = await readFile(`${base}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      return {
        start: fields[19],
        executable: await readlink(`${base}/exe`),
        arguments: (await readFile(`${base}/cmdline`, "utf8")).split("\0"),
      };
    }
    if (process.platform !== "darwin")
      throw new Error("Unsupported native cleanup platform");
    const ps = async (field) =>
      (
        await run("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
          timeout: 2_000,
          maxBuffer: 16 * 1024,
        })
      ).stdout.trim();
    const start = await ps("lstart");
    if ((await ps("state")).includes("Z")) return null;
    const executable = await ps("comm");
    const command = await ps("command");
    if (!start || !executable || start !== (await ps("lstart")))
      throw new Error("Process identity changed during observation");
    return { start, executable, arguments: command.split(/\s+/u) };
  } catch (error) {
    if (
      (process.platform === "linux" && error.code === "ENOENT") ||
      error.code === "ESRCH" ||
      (error.code === 1 && error.stdout === "" && error.stderr === "")
    )
      return null;
    throw error;
  }
}

export async function requestFixtureControl(config, identity, action) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(config.controlSocket);
    let received = "";
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(2_000, () =>
      finish(new Error("Owned fixture control timed out")),
    );
    socket.once("error", () =>
      finish(new Error("Owned fixture control unavailable")),
    );
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          action,
          token: config.controlToken,
          pid: identity.pid,
          bootId: identity.bootId,
          executable: identity.executable,
          start: identity.start,
          receiptId: config.receiptId,
        }) + "\n",
      ),
    );
    socket.on("data", (data) => {
      received += data.toString("utf8");
      if (received.length > 4096)
        return finish(new Error("Invalid owned control response"));
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(received.slice(0, newline));
      } catch {
        return finish(new Error("Invalid owned control response"));
      }
      if (
        response.ok !== true ||
        response.pid !== identity.pid ||
        response.bootId !== identity.bootId ||
        response.start !== identity.start ||
        response.executable !== identity.executable ||
        response.receiptId !== config.receiptId
      )
        return finish(new Error("Owned fixture control identity mismatch"));
      finish(undefined, response);
    });
    socket.once("end", () => {
      if (!received.includes("\n"))
        finish(new Error("Owned fixture control closed without a response"));
    });
  });
}

export async function settleOwnedLaunch(
  config,
  executable,
  { allowTerminate, waitMs = 10_000 } = {},
) {
  const outcome = { exited: false, forced: false };
  try {
    const identity = JSON.parse(await readFile(config.ownershipFile, "utf8"));
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      identity.receiptId !== config.receiptId ||
      identity.round !== config.round ||
      typeof identity.bootId !== "string" ||
      !identity.bootId ||
      typeof identity.start !== "string" ||
      !identity.start ||
      (await realpath(identity.executable)) !== (await realpath(executable))
    )
      throw new Error("Missing or mismatched owned fixture identity");
    outcome.pid = identity.pid;
    const verify = async () => {
      const current = await nativeProcessIdentity(identity.pid);
      if (!current) return null;
      if (
        current.start !== identity.start ||
        (await realpath(current.executable)) !== (await realpath(executable)) ||
        !current.arguments.includes(
          `--zenx-launch-path-instance=${config.receiptId}`,
        )
      )
        throw new Error("Owned fixture process identity changed");
      return current;
    };
    if (!(await verify())) return { ...outcome, exited: true };
    await requestFixtureControl(config, identity, "inspect");
    if (!allowTerminate)
      throw new Error(
        "LaunchServices returned while its owned app is still running",
      );
    // Verify OS identity again, then ask the authenticated independent worker to
    // signal only its own live process. There is no parent-side PID kill fallback.
    if (!(await verify())) return { ...outcome, exited: true };
    await requestFixtureControl(config, identity, "terminate");
    outcome.forced = true;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!(await verify())) return { ...outcome, exited: true };
      await delay(50);
    }
    throw new Error("Owned fixture exit could not be confirmed");
  } catch (error) {
    // Never include control credentials or complete process arguments in reports.
    return {
      ...outcome,
      error:
        error.code === "ENOENT"
          ? "Owned fixture identity is missing"
          : String(error),
    };
  }
}

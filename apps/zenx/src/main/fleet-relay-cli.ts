import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serveFleetRelay, type FleetRelayServer } from "./fleet-relay.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Invalid Fleet relay private configuration");
}
async function readRegular(
  file: string,
  privateFile: boolean,
  maximum: number,
): Promise<Buffer> {
  if (!path.isAbsolute(file))
    throw new Error("Fleet relay configuration paths must be absolute");
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.size > maximum ||
    (privateFile &&
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())))
  )
    throw new Error(
      "Fleet relay requires protected regular configuration and key files",
    );
  return readFile(file);
}
/** No secret-bearing CLI arguments, environment fallback, or saved credentials. */
export async function startFleetRelayFromFile(
  file: string,
): Promise<FleetRelayServer> {
  const data: unknown = JSON.parse(
    (await readRegular(file, true, 64 * 1024)).toString("utf8"),
  );
  if (!record(data))
    throw new Error("Invalid Fleet relay private configuration");
  only(data, [
    "version",
    "enabled",
    "listen",
    "port",
    "tlsCertificateFile",
    "tlsKeyFile",
    "registrations",
    "originEndpoint",
  ]);
  if (
    data.version !== 1 ||
    data.enabled !== true ||
    typeof data.listen !== "string" ||
    typeof data.port !== "number" ||
    typeof data.tlsCertificateFile !== "string" ||
    typeof data.tlsKeyFile !== "string" ||
    !Array.isArray(data.registrations) ||
    (data.originEndpoint !== undefined &&
      typeof data.originEndpoint !== "string")
  )
    throw new Error("Invalid Fleet relay private configuration");
  const registrations = data.registrations.map((value: unknown) => {
    if (!record(value))
      throw new Error("Invalid Fleet relay registration inventory");
    only(value, ["hostId", "tokenSha256"]);
    if (
      typeof value.hostId !== "string" ||
      typeof value.tokenSha256 !== "string"
    )
      throw new Error("Invalid Fleet relay registration inventory");
    return { hostId: value.hostId, tokenSha256: value.tokenSha256 };
  });
  const cert = await readRegular(data.tlsCertificateFile, false, 128 * 1024);
  const key = await readRegular(data.tlsKeyFile, true, 128 * 1024);
  return serveFleetRelay({
    enabled: true,
    listen: data.listen,
    port: data.port,
    tls: { cert, key },
    registrations,
    ...(data.originEndpoint === undefined
      ? {}
      : { originEndpoint: data.originEndpoint }),
  });
}
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--config")
    throw new Error(
      "Usage: node --import tsx apps/zenx/src/main/fleet-relay-cli.ts --config /absolute/private-config.json",
    );
  const server = await startFleetRelayFromFile(process.argv[3]!);
  process.stdout.write(`Fleet relay listening at ${server.endpoint}\n`);
  const stop = () => {
    void server.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.stderr.write("Fleet relay shutdown failed\n");
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    process.stderr.write(
      "Fleet relay could not start. Check explicit private configuration, TLS identity, and listen address.\n",
    );
    process.exitCode = 1;
  });
}

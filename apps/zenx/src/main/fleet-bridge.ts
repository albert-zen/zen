import { watchFleetBridge } from "./fleet-bridge-watch.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZenXProtocolClient } from "../protocol-client/protocol-client.js";
import { readZenXConnectionDescriptor } from "../protocol-client/connection-descriptor.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "./capabilities/self-control-package.js";
import { fleetTools, type FleetRequest } from "./fleet.js";

/** Runs under the remote user's existing SSH account; Host bearer never leaves it. */
export async function invokeFleetBridge(
  descriptorFile: string,
  input: unknown,
) {
  const request = input as FleetRequest;
  if (
    !request ||
    (request.version !== 1 && request.version !== 2) ||
    !fleetTools.has(request.name) ||
    typeof request.callId !== "string" ||
    !request.callId ||
    request.callId.length > 512 ||
    !request.arguments ||
    typeof request.arguments !== "object" ||
    Array.isArray(request.arguments) ||
    request.arguments.device !== undefined ||
    (request.threadId !== undefined && typeof request.threadId !== "string") ||
    (request.canonicalToolCallId !== undefined &&
      typeof request.canonicalToolCallId !== "string")
  )
    throw new Error("Invalid Fleet request");
  if (
    request.version === 2 &&
    (request.name !== "zenx_threads_send" ||
      typeof request.arguments.threadId !== "string" ||
      request.arguments.target !== undefined)
  )
    throw new Error("Invalid Fleet request");
  const descriptor = await readZenXConnectionDescriptor(descriptorFile);
  const client = await ZenXProtocolClient.connect({
    url: descriptor.url,
    bearerTokenFile: descriptor.authentication.tokenFile,
    clientInfo: { name: "zenx-fleet", title: "ZenX Fleet", version: "1" },
    reconnect: { maxAttempts: 1 },
  });
  try {
    const port = new MutableAppServerRequestPort();
    let workspace: string | null = null;
    let workspaces: string[] = [];
    try {
      const profile = JSON.parse(
        await readFile(
          path.join(
            path.dirname(path.dirname(descriptorFile)),
            "host-profile.json",
          ),
          "utf8",
        ),
      );
      if (
        profile.workspace !== null &&
        profile.workspace !== undefined &&
        typeof profile.workspace !== "string"
      )
        throw new Error("Invalid Host workspace");
      if (
        !Array.isArray(profile.workspaces) ||
        profile.workspaces.some((x: unknown) => typeof x !== "string")
      )
        throw new Error("Invalid Host workspaces");
      workspace = profile.workspace ?? null;
      workspaces = profile.workspaces;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await port.attach(client, workspace, workspaces);
    const pkg = new ZenXSelfControlCapabilityPackage({
      appServer: port,
      sendPreference: async () => "soft",
    });
    return await pkg.invoke(request.name, {
      ...request,
      cwd: process.cwd(),
      signal: AbortSignal.timeout(35_000),
    });
  } finally {
    client.close();
  }
}
async function main() {
  let bytes = 0;
  const parts: Buffer[] = [];
  const timer = setTimeout(() => {
    process.stderr.write("Fleet bridge deadline exceeded\n");
    process.exit(1);
  }, 40_000);
  try {
    for await (const part of process.stdin) {
      const buffer = Buffer.from(part as Uint8Array);
      bytes += buffer.length;
      if (bytes > 128 * 1024) throw new Error("Fleet request too large");
      parts.push(buffer);
    }
    const descriptor = process.argv[2];
    if (!descriptor)
      throw new Error("Pass the local ZenX connection descriptor path");
    const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (input?.watch === true) {
      await watchFleetBridge(descriptor, input, (event) => {
        if ((event as { type?: string }).type === "ready") clearTimeout(timer);
        process.stdout.write(JSON.stringify(event) + "\n");
      });
      return;
    }
    const result = await invokeFleetBridge(descriptor, input);
    process.stdout.write(JSON.stringify({ version: 1, ok: true, result }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        ok: false,
        error: error instanceof Error ? error.message : "Fleet request failed",
      }) + "\n",
    );
  } finally {
    clearTimeout(timer);
  }
}
// Separate build entry is runnable with Node; importing it in tests has no effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ZenXPluginDevRequest,
  ZenXPluginDevResult,
  ZenXPluginDevTargetDescriptor,
} from "@zenx/plugin-sdk";

const MAX_REQUEST_BYTES = 64 * 1024;

export interface ZenXPluginDevControlOptions {
  descriptorFile: string;
  tokenFile: string;
  install(request: ZenXPluginDevRequest): Promise<{
    pluginId: string;
    packageName: string;
    generation: string;
  }>;
  reload(
    pluginId: string,
  ): Promise<{ status: "reloaded" } | { status: "failed"; message: string }>;
}

/** Explicit, authenticated loopback control seam for one running ZenX instance. */
export class ZenXPluginDevControlServer {
  readonly #server: Server;
  readonly #descriptorFile: string;
  readonly #tokenFile: string;
  #closed = false;

  private constructor(
    server: Server,
    descriptorFile: string,
    tokenFile: string,
  ) {
    this.#server = server;
    this.#descriptorFile = descriptorFile;
    this.#tokenFile = tokenFile;
  }

  static async start(
    options: ZenXPluginDevControlOptions,
  ): Promise<ZenXPluginDevControlServer> {
    const token = randomBytes(32).toString("hex");
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      try {
        if (request.method !== "POST" || request.url !== "/v1/plugins/dev") {
          response.writeHead(404);
          response.end(JSON.stringify({ message: "Unknown plugin dev route" }));
          return;
        }
        if (!authorized(request.headers.authorization, token)) {
          response.writeHead(401);
          response.end(
            JSON.stringify({ message: "Plugin dev authorization failed" }),
          );
          return;
        }
        const devRequest = assertDevRequest(
          JSON.parse(await readRequestBody(request)) as unknown,
        );
        const installed = await options.install(devRequest);
        if (
          installed.pluginId !== devRequest.pluginId ||
          installed.packageName !== devRequest.packageName
        ) {
          throw new Error(
            "Installed plugin identity does not match dev request",
          );
        }
        const result: ZenXPluginDevResult = {
          version: 1,
          pluginId: installed.pluginId,
          packageName: installed.packageName,
          generation: installed.generation,
          reload: await options.reload(installed.pluginId),
        };
        response.writeHead(200);
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400);
        response.end(
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Plugin dev control server has no loopback address");
      }
      await mkdir(path.dirname(options.descriptorFile), {
        recursive: true,
        mode: 0o700,
      });
      await writePrivateFile(options.tokenFile, `${token}\n`);
      const descriptor: ZenXPluginDevTargetDescriptor = {
        version: 1,
        transport: "http",
        url: `http://127.0.0.1:${String(address.port)}`,
        authentication: {
          type: "bearer-file",
          tokenFile: path.resolve(options.tokenFile),
        },
      };
      await writePrivateFile(
        options.descriptorFile,
        `${JSON.stringify(descriptor)}\n`,
      );
      return new ZenXPluginDevControlServer(
        server,
        options.descriptorFile,
        options.tokenFile,
      );
    } catch (error) {
      server.close();
      await removeFile(options.descriptorFile);
      await removeFile(options.tokenFile);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    await removeFile(this.#descriptorFile);
    await removeFile(this.#tokenFile);
  }
}

function assertDevRequest(value: unknown): ZenXPluginDevRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { projectDirectory?: unknown }).projectDirectory !==
      "string" ||
    !path.isAbsolute(
      (value as { projectDirectory: string }).projectDirectory,
    ) ||
    typeof (value as { packageName?: unknown }).packageName !== "string" ||
    typeof (value as { pluginId?: unknown }).pluginId !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/u.test((value as { pluginId: string }).pluginId)
  ) {
    throw new Error("Invalid ZenX plugin dev request");
  }
  return value as ZenXPluginDevRequest;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES)
      throw new Error("Plugin dev request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

async function writePrivateFile(
  filePath: string,
  value: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

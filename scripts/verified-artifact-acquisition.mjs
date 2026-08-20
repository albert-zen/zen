import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { EnvHttpProxyAgent, fetch } from "undici";

const digestPattern = /^[a-f0-9]{64}$/u;
const maxArtifactBytes = 512 * 1024 * 1024;
const maxConnectMilliseconds = 10_000;
const readBufferBytes = 64 * 1024;

/**
 * Acquire one digest-addressed immutable file. Cache verification, proxy-aware
 * transport, timeouts, streaming bounds, partial cleanup, and atomic cache
 * publication stay behind this interface.
 */
export async function acquireVerifiedArtifact(options) {
  const artifactName = requiredString(options?.artifactName, "artifactName");
  const source = sourceDescription(options?.url);
  const digest = requiredDigest(options?.digest);
  const deadline = requiredDeadline(options?.deadline);
  const cacheLocation = requiredString(options?.cacheLocation, "cacheLocation");
  const cacheDirectory = path.resolve(cacheLocation, "sha256");
  const cacheFile = path.join(cacheDirectory, digest);

  try {
    ensureBeforeDeadline(deadline);
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    if (await isVerifiedFile(cacheFile, digest, deadline)) {
      await makeImmutable(cacheFile);
      return cacheFile;
    }
    await removeInvalidCacheEntry(cacheFile);
    return await downloadAndPublish({
      url: options.url,
      digest,
      deadline,
      cacheDirectory,
      cacheFile,
    });
  } catch (error) {
    const reason = acquisitionReason(error);
    throw new Error(
      `Verified artifact acquisition failed for ${artifactName} from ${source}: ${reason}`,
    );
  }
}

async function downloadAndPublish(options) {
  const partialFile = path.join(
    options.cacheDirectory,
    `.${options.digest}.${randomUUID()}.partial`,
  );
  const remaining = remainingMilliseconds(options.deadline);
  const dispatcher = new EnvHttpProxyAgent({
    connectTimeout: Math.min(maxConnectMilliseconds, remaining),
    headersTimeout: remaining,
    bodyTimeout: remaining,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("artifact acquisition deadline")),
    remaining,
  );
  timeout.unref();

  try {
    const response = await fetch(options.url, {
      dispatcher,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw acquisitionFailure(`source responded with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const advertisedBytes = Number(contentLength);
      if (
        !Number.isSafeInteger(advertisedBytes) ||
        advertisedBytes < 0 ||
        advertisedBytes > maxArtifactBytes
      ) {
        throw acquisitionFailure("response exceeds the stream size bound");
      }
    }

    const file = await open(partialFile, "wx", 0o600);
    let receivedBytes = 0;
    const hash = createHash("sha256");
    try {
      if (response.body !== null) {
        for await (const chunk of response.body) {
          ensureBeforeDeadline(options.deadline);
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxArtifactBytes) {
            throw acquisitionFailure("response exceeds the stream size bound");
          }
          hash.update(chunk);
          await file.write(chunk);
        }
      }
      if (contentLength !== null && receivedBytes !== Number(contentLength)) {
        throw acquisitionFailure("response body was incomplete");
      }
      const actual = hash.digest("hex");
      if (actual !== options.digest) {
        throw acquisitionFailure("digest mismatch");
      }
      await file.sync();
      await file.chmod(0o444);
    } finally {
      await file.close();
    }

    ensureBeforeDeadline(options.deadline);
    try {
      await link(partialFile, options.cacheFile);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (
        !(await isVerifiedFile(
          options.cacheFile,
          options.digest,
          options.deadline,
        ))
      ) {
        throw acquisitionFailure(
          "atomic cache publication collided with an invalid entry",
        );
      }
    }
    await makeImmutable(options.cacheFile);
    return options.cacheFile;
  } catch (error) {
    if (controller.signal.aborted) {
      throw acquisitionFailure("overall deadline exceeded");
    }
    throw normalizeTransportFailure(error);
  } finally {
    clearTimeout(timeout);
    await dispatcher.destroy().catch(() => {});
    await rm(partialFile, { force: true });
  }
}

async function isVerifiedFile(file, expectedDigest, deadline) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.size > maxArtifactBytes) return false;

  const handle = await open(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(readBufferBytes);
  let position = 0;
  try {
    while (true) {
      ensureBeforeDeadline(deadline);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > maxArtifactBytes) return false;
    }
  } finally {
    await handle.close();
  }
  ensureBeforeDeadline(deadline);
  return hash.digest("hex") === expectedDigest;
}

async function removeInvalidCacheEntry(file) {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function makeImmutable(file) {
  await chmod(file, 0o444);
}

function normalizeTransportFailure(error) {
  if (error?.name === "VerifiedArtifactAcquisitionFailure") return error;
  const code = error?.cause?.code ?? error?.code;
  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return acquisitionFailure("connect timeout exceeded");
  }
  if (
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH" ||
    code === "ECONNRESET"
  ) {
    return acquisitionFailure("response body was incomplete");
  }
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return acquisitionFailure("overall deadline exceeded");
  }
  return acquisitionFailure("source request failed");
}

function acquisitionReason(error) {
  return error?.name === "VerifiedArtifactAcquisitionFailure"
    ? error.message
    : "local cache operation failed";
}

function acquisitionFailure(message) {
  const error = new Error(message);
  error.name = "VerifiedArtifactAcquisitionFailure";
  return error;
}

function ensureBeforeDeadline(deadline) {
  if (Date.now() >= deadline) {
    throw acquisitionFailure("overall deadline exceeded");
  }
}

function remainingMilliseconds(deadline) {
  ensureBeforeDeadline(deadline);
  return Math.max(1, Math.min(2_147_483_647, deadline - Date.now()));
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredDigest(value) {
  if (typeof value !== "string" || !digestPattern.test(value.toLowerCase())) {
    throw new TypeError("digest must be a SHA-256 hex digest");
  }
  return value.toLowerCase();
}

function requiredDeadline(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      "deadline must be a Unix epoch timestamp in milliseconds",
    );
  }
  return value;
}

function sourceDescription(value) {
  const parsed = new URL(requiredString(value, "url"));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("url must use HTTP or HTTPS");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

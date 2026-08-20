import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { EnvHttpProxyAgent, fetch } from "undici";

const digestPattern = /^[a-f0-9]{64}$/u;
const maxArtifactBytes = 512 * 1024 * 1024;
const maxConnectMilliseconds = 10_000;
// Production acquisitions use a two-minute deadline. A dead owner is reaped
// immediately by PID; PID reuse or a corrupt future deadline can delay cleanup
// only until this lease bound, and an owner revalidates its ticket before
// invalid cleanup and atomic publish.
const maxTransactionLeaseMilliseconds = 5 * 60_000;
const readBufferBytes = 64 * 1024;
const transactionInitializationGraceMilliseconds = 2_000;
const transactionRetirementGraceMilliseconds = 5_000;
const transactionRenameRetryMilliseconds = 5_000;
const transactionWaitMilliseconds = 25;

/**
 * Acquire one digest-addressed immutable file. Cache verification, proxy-aware
 * transport, timeouts, streaming bounds, partial cleanup, no-follow cache
 * handling, and the per-digest cross-process transaction stay behind this
 * interface.
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
    return await withDigestTransaction({
      cacheDirectory,
      digest,
      deadline,
      action: async (transaction) => {
        if (await isVerifiedFile(cacheFile, digest, deadline)) {
          return cacheFile;
        }
        await assertTransactionOwner(transaction);
        await removeInvalidCacheEntry(cacheFile);
        await assertTransactionOwner(transaction);
        return await downloadAndPublish({
          url: options.url,
          digest,
          deadline,
          cacheDirectory,
          cacheFile,
          transaction,
        });
      },
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
    await assertTransactionOwner(options.transaction);
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
  let pathMetadata;
  try {
    pathMetadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!pathMetadata.isFile() || pathMetadata.size > maxArtifactBytes) {
    return false;
  }

  let handle;
  try {
    handle = await openRegularFileNoFollow(file);
  } catch (error) {
    if (isMissingOrSymlinkError(error)) return false;
    throw error;
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(readBufferBytes);
  let position = 0;
  try {
    const handleMetadata = await handle.stat();
    if (
      !handleMetadata.isFile() ||
      !sameFile(pathMetadata, handleMetadata) ||
      handleMetadata.size > maxArtifactBytes
    ) {
      return false;
    }
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
    ensureBeforeDeadline(deadline);
    const currentPathMetadata = await lstat(file).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      currentPathMetadata === undefined ||
      !sameFile(currentPathMetadata, handleMetadata) ||
      hash.digest("hex") !== expectedDigest
    ) {
      return false;
    }
    await handle.chmod(0o444);
    return true;
  } finally {
    await handle.close();
  }
}

async function removeInvalidCacheEntry(file) {
  const quarantine = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.invalid`,
  );
  try {
    await rename(file, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  let shouldRestore = true;
  try {
    const pathMetadata = await lstat(quarantine);
    if (pathMetadata.isSymbolicLink()) {
      await unlink(quarantine);
      shouldRestore = false;
      return;
    }
    if (!pathMetadata.isFile()) {
      throw acquisitionFailure("invalid cache entry is not a regular file");
    }

    const handle = await openRegularFileNoFollow(quarantine);
    try {
      const handleMetadata = await handle.stat();
      if (!handleMetadata.isFile() || !sameFile(pathMetadata, handleMetadata)) {
        throw acquisitionFailure("invalid cache entry changed during cleanup");
      }
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await unlink(quarantine);
    shouldRestore = false;
  } finally {
    if (shouldRestore) {
      await rename(quarantine, file).catch(() => {});
    }
  }
}

async function openRegularFileNoFollow(file) {
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  return await open(file, flags);
}

async function withDigestTransaction(options) {
  const transactionRoot = path.join(
    options.cacheDirectory,
    ".transactions",
    options.digest,
  );
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  const transaction = await acquireTransaction({
    transactionRoot,
    deadline: options.deadline,
  });
  try {
    await assertTransactionOwner(transaction);
    return await options.action(transaction);
  } finally {
    await retireTransactionDirectory(
      transaction.transactionRoot,
      transaction.directory,
      transaction.deadline,
    );
  }
}

async function acquireTransaction(options) {
  // Unique contender directories avoid a fixed lock pathname's stale-cleanup
  // ABA race. Each contender chooses one ticket, then waits for every lower
  // (ticket, token) pair; newcomers observe the published ticket and queue later.
  const token = randomUUID();
  const createdAt = Date.now();
  const candidateDirectory = path.join(
    options.transactionRoot,
    `candidate-${token}`,
  );
  const directory = path.join(options.transactionRoot, `participant-${token}`);
  const owner = {
    version: 1,
    token,
    pid: process.pid,
    createdAt,
    deadline: options.deadline,
  };
  await mkdir(candidateDirectory, { mode: 0o700 });
  try {
    await Promise.all([
      writeFile(
        path.join(candidateDirectory, "owner.json"),
        `${JSON.stringify(owner)}\n`,
        { mode: 0o600 },
      ),
      writeFile(path.join(candidateDirectory, "choosing"), "", {
        mode: 0o600,
      }),
    ]);
    await renameTransactionPath(
      candidateDirectory,
      directory,
      options.deadline,
    );

    const participants = await activeParticipants(
      options.transactionRoot,
      options.deadline,
    );
    const ticket =
      participants.reduce(
        (maximum, participant) =>
          participant.ticket === undefined
            ? maximum
            : Math.max(maximum, participant.ticket),
        0,
      ) + 1;
    if (!Number.isSafeInteger(ticket)) {
      throw acquisitionFailure("cache transaction ticket space exhausted");
    }
    await writeFile(path.join(directory, "ticket"), `${String(ticket)}\n`, {
      mode: 0o600,
    });
    await unlink(path.join(directory, "choosing"));

    const transaction = {
      transactionRoot: options.transactionRoot,
      directory,
      token,
      ticket,
      deadline: options.deadline,
    };
    while (true) {
      ensureBeforeDeadline(options.deadline);
      if (!(await hasPrecedingParticipant(transaction))) return transaction;
      await waitForTransaction(options.deadline);
    }
  } catch (error) {
    await retireTransactionDirectory(
      options.transactionRoot,
      candidateDirectory,
      options.deadline,
    );
    await retireTransactionDirectory(
      options.transactionRoot,
      directory,
      options.deadline,
    );
    throw error;
  }
}

async function hasPrecedingParticipant(transaction) {
  const participants = await activeParticipants(
    transaction.transactionRoot,
    transaction.deadline,
  );
  for (const participant of participants) {
    if (participant.token === transaction.token) continue;
    if (participant.choosing) return true;
    if (participant.ticket === undefined) {
      throw acquisitionFailure("cache transaction state is invalid");
    }
    if (
      participant.ticket < transaction.ticket ||
      (participant.ticket === transaction.ticket &&
        participant.token < transaction.token)
    ) {
      return true;
    }
  }
  return false;
}

async function activeParticipants(transactionRoot, deadline) {
  const result = [];
  for (const entry of await readdir(transactionRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("retired-")) {
      await removeRetiredDirectory(path.join(transactionRoot, entry.name));
      continue;
    }
    if (
      !entry.isDirectory() ||
      (!entry.name.startsWith("candidate-") &&
        !entry.name.startsWith("participant-"))
    ) {
      continue;
    }
    const participant = await readParticipant(
      path.join(transactionRoot, entry.name),
      entry.name,
    );
    if (participant === undefined) continue;
    if (participant.stale) {
      await retireTransactionDirectory(
        transactionRoot,
        participant.directory,
        deadline,
      );
      continue;
    }
    result.push(participant);
  }
  return result;
}

async function retireTransactionDirectory(
  transactionRoot,
  directory,
  deadline,
) {
  // Removing the active name atomically keeps observers from reading a
  // half-deleted owner/ticket pair. A crash after rename leaves only inert state
  // that the next scan removes.
  const retiredDirectory = path.join(
    transactionRoot,
    `retired-${path.basename(directory)}-${randomUUID()}`,
  );
  try {
    await renameTransactionPath(
      directory,
      retiredDirectory,
      Math.min(deadline, Date.now() + transactionRenameRetryMilliseconds),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return;
    try {
      await lstat(directory);
    } catch (observationError) {
      if (observationError?.code === "ENOENT") return;
      throw observationError;
    }
    throw error;
  }
  await removeRetiredDirectory(retiredDirectory);
}

async function removeRetiredDirectory(directory) {
  try {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: transactionWaitMilliseconds,
    });
  } catch (error) {
    // A retired name is already inert. Windows may keep it briefly busy while
    // another contender is observing or deleting it; a later scan can finish
    // this non-authoritative cleanup without blocking artifact acquisition.
    if (
      error?.code === "ENOENT" ||
      error?.code === "EPERM" ||
      error?.code === "EBUSY" ||
      error?.code === "ENOTEMPTY"
    ) {
      return;
    }
    throw error;
  }
}

async function renameTransactionPath(source, destination, deadline) {
  while (true) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        error?.code !== "EPERM" &&
        error?.code !== "EBUSY" &&
        error?.code !== "EACCES"
      ) {
        throw error;
      }
      ensureBeforeDeadline(deadline);
      await waitForTransaction(deadline);
    }
  }
}

async function readParticipant(directory, name) {
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!directoryMetadata.isDirectory()) return undefined;

  let owner;
  try {
    owner = JSON.parse(
      await readFile(path.join(directory, "owner.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
      throw error;
  }
  const observedAt = Date.now();
  const token = name.replace(/^(?:candidate|participant)-/u, "");
  const ownerFieldsAreValid =
    owner?.version === 1 &&
    owner.token === token &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    Number.isSafeInteger(owner.createdAt) &&
    owner.createdAt >= 0 &&
    Number.isSafeInteger(owner.deadline) &&
    owner.deadline >= owner.createdAt;
  const ownerTimeIsFuture =
    ownerFieldsAreValid &&
    owner.createdAt > observedAt + transactionInitializationGraceMilliseconds;
  const validOwner = ownerFieldsAreValid && !ownerTimeIsFuture;
  const directoryTimeIsFuture =
    directoryMetadata.mtimeMs >
    observedAt + transactionInitializationGraceMilliseconds;
  const age = Math.max(0, observedAt - directoryMetadata.mtimeMs);
  if (!validOwner) {
    return await returnIfParticipantPathUnchanged(
      directory,
      directoryMetadata,
      {
        directory,
        token,
        choosing: true,
        ticket: undefined,
        // candidate-* can be observed between mkdir and owner publication.
        // participant-* is published only after owner + choosing are present,
        // so malformed published state is safe to quarantine immediately.
        stale:
          name.startsWith("participant-") ||
          ownerTimeIsFuture ||
          directoryTimeIsFuture ||
          age >= transactionInitializationGraceMilliseconds,
      },
    );
  }

  const retirementDeadline = Math.min(
    owner.deadline + transactionRetirementGraceMilliseconds,
    owner.createdAt + maxTransactionLeaseMilliseconds,
  );
  const stale = !processIsAlive(owner.pid) || observedAt >= retirementDeadline;
  if (stale) {
    return await returnIfParticipantPathUnchanged(
      directory,
      directoryMetadata,
      { directory, token, choosing: true, ticket: undefined, stale },
    );
  }

  const choosing =
    name.startsWith("candidate-") ||
    (await pathExists(path.join(directory, "choosing")));
  let ticket;
  try {
    const value = Number(
      (await readFile(path.join(directory, "ticket"), "utf8")).trim(),
    );
    if (Number.isSafeInteger(value) && value > 0) ticket = value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return await returnIfParticipantPathUnchanged(directory, directoryMetadata, {
    directory,
    token,
    choosing,
    ticket,
    // A published participant without either an in-progress choosing marker or
    // a valid ticket cannot become valid. Quarantine it instead of allowing it
    // to reject every later acquisition.
    stale: name.startsWith("participant-") && !choosing && ticket === undefined,
  });
}

async function returnIfParticipantPathUnchanged(
  directory,
  directoryMetadata,
  participant,
) {
  let currentMetadata;
  try {
    currentMetadata = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !currentMetadata.isDirectory() ||
    !sameFile(directoryMetadata, currentMetadata)
  ) {
    return undefined;
  }
  return participant;
}

async function assertTransactionOwner(transaction) {
  ensureBeforeDeadline(transaction.deadline);
  const participant = await readParticipant(
    transaction.directory,
    `participant-${transaction.token}`,
  );
  if (
    participant === undefined ||
    participant.stale ||
    participant.choosing ||
    participant.ticket !== transaction.ticket
  ) {
    throw acquisitionFailure("cache transaction ownership expired");
  }
}

async function waitForTransaction(deadline) {
  const wait = Math.min(
    transactionWaitMilliseconds,
    remainingMilliseconds(deadline),
  );
  await new Promise((resolve) => setTimeout(resolve, wait));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissingOrSymlinkError(error) {
  return (
    error?.code === "ENOENT" ||
    error?.code === "ELOOP" ||
    error?.code === "EMLINK"
  );
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

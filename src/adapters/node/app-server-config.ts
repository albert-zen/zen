import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const DEFAULT_APP_SERVER_HOST = '127.0.0.1';
export const DEFAULT_APP_SERVER_PORT = 3000;

export type AppServerClientHandoff = {
  readonly baseUrl: string;
  readonly capability: string;
};

export type PublishedAppServerClientHandoff = {
  readonly ownershipMarker: string;
  readonly path: string;
};

export type AppServerCredentialMode =
  | { readonly type: 'provided'; readonly capability: string }
  | { readonly type: 'handoff'; readonly directory: string };

export function readAppServerPort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_APP_SERVER_PORT;
  }

  const port = Number(value);

  if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
    return port;
  }

  throw new Error('ZEN_APP_SERVER_PORT must be an integer from 0 to 65535');
}

export function readRemoteBindOptIn(value: string | undefined, variableName: string): boolean {
  if (value === undefined || value === '0' || value === 'false') {
    return false;
  }

  if (value === '1' || value === 'true') {
    return true;
  }

  throw new Error(`${variableName} must be one of: 0, 1, false, true`);
}

export function readAppServerCredentialMode(
  env: Readonly<Record<string, string | undefined>>
): AppServerCredentialMode {
  const capability = env.ZEN_APP_SERVER_CAPABILITY;
  const directory = env.ZEN_APP_SERVER_CAPABILITY_DIR;

  if (Boolean(capability) === Boolean(directory)) {
    throw new Error(
      'Set exactly one of ZEN_APP_SERVER_CAPABILITY or ZEN_APP_SERVER_CAPABILITY_DIR'
    );
  }

  if (capability) {
    return { type: 'provided', capability };
  }

  if (directory) {
    return { type: 'handoff', directory };
  }

  throw new Error('App Server credential mode is invalid');
}

export function assertLoopbackBindAllowed(
  host: string,
  allowRemoteBind: boolean,
  serverName: string
): void {
  if (!allowRemoteBind && !isLoopbackHost(host)) {
    throw new Error(`${serverName} binding requires explicit opt-in`);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, '');

  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  if (isIP(normalized) === 4) {
    return normalized.startsWith('127.');
  }

  return normalized.startsWith('::ffff:127.');
}

export async function publishAppServerClientHandoff(
  directory: string,
  handoff: AppServerClientHandoff
): Promise<PublishedAppServerClientHandoff> {
  const ownershipMarker = randomBytes(32).toString('base64url');
  const filename = `zen-app-server-${randomUUID()}.json`;
  const path = join(directory, filename);
  const temporaryPath = join(directory, `.${filename}.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, 'wx', 0o600);

  try {
    try {
      await file.writeFile(`${JSON.stringify({ ...handoff, ownershipMarker })}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    // A hard link publishes the already-flushed inode without an overwrite window.
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return { ownershipMarker, path };
}

export async function consumeAppServerClientHandoff(path: string): Promise<AppServerClientHandoff> {
  const claimedPath = `${path}.${process.pid}.${randomUUID()}.consuming`;
  await rename(path, claimedPath);

  try {
    return readAppServerClientHandoff(await readFile(claimedPath, 'utf8'));
  } finally {
    await rm(claimedPath, { force: true });
  }
}

export async function cleanupPublishedAppServerClientHandoff(
  published: PublishedAppServerClientHandoff
): Promise<void> {
  const cleanupPath = `${published.path}.${process.pid}.${randomUUID()}.cleaning`;

  try {
    await rename(published.path, cleanupPath);
  } catch (cause) {
    if (isFileNotFound(cause)) {
      return;
    }

    throw cause;
  }

  let isOwned: boolean;

  try {
    const before = await lstat(cleanupPath);
    const contents = await readFile(cleanupPath, 'utf8');
    const after = await lstat(cleanupPath);

    isOwned =
      before.dev === after.dev &&
      before.ino === after.ino &&
      readOwnershipMarker(contents) === published.ownershipMarker;
  } catch (cause) {
    await restoreClaimedHandoff(cleanupPath, published.path);
    throw cause;
  }

  if (isOwned) {
    await rm(cleanupPath);
    return;
  }

  await restoreClaimedHandoff(cleanupPath, published.path);
}

async function restoreClaimedHandoff(claimedPath: string, publicPath: string): Promise<void> {
  try {
    await link(claimedPath, publicPath);
  } catch (cause) {
    if (isFileExists(cause)) {
      return;
    }

    throw cause;
  }

  // The exclusive public hard link now owns the same inode; remove only the
  // private cleanup name. If publicPath exists, both objects remain untouched.
  await rm(claimedPath);
}

function readOwnershipMarker(contents: string): string | undefined {
  try {
    const value = JSON.parse(contents) as unknown;

    if (
      typeof value === 'object' &&
      value !== null &&
      'ownershipMarker' in value &&
      typeof value.ownershipMarker === 'string'
    ) {
      return value.ownershipMarker;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isFileNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function isFileExists(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST';
}

function readAppServerClientHandoff(contents: string): AppServerClientHandoff {
  const value = JSON.parse(contents) as unknown;

  if (
    typeof value !== 'object' ||
    value === null ||
    !('baseUrl' in value) ||
    typeof value.baseUrl !== 'string' ||
    !('capability' in value) ||
    typeof value.capability !== 'string' ||
    !('ownershipMarker' in value) ||
    typeof value.ownershipMarker !== 'string'
  ) {
    throw new Error('App Server client handoff is invalid');
  }

  new URL(value.baseUrl);
  return { baseUrl: value.baseUrl, capability: value.capability };
}

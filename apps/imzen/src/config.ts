import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveAgentAppDataRoot } from '@zen/framework/node';

export type QQBotCredential = {
  readonly appId: string;
  readonly appSecret: string;
};

export type ImZenConfig = {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly appServerCapability: string;
  readonly appServerUrl: string;
  readonly dataDir: string;
  readonly projectId?: string;
  readonly projectRoot: string;
  readonly qqApiBase: string;
  readonly qqCredential: QQBotCredential;
  readonly qqSecretFile: string;
};

const DEFAULT_QQ_API_BASE = 'https://api.sgroup.qq.com';
const TRUSTED_QQ_API_HOSTS = new Set(['api.sgroup.qq.com', 'sandbox.api.sgroup.qq.com']);

export async function loadImZenConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd()
): Promise<ImZenConfig> {
  const secretFile = required(env.IMZEN_QQ_SECRET_FILE, 'IMZEN_QQ_SECRET_FILE');
  const appServerUrl = validateAppServerUrl(required(env.ZEN_APP_SERVER_URL, 'ZEN_APP_SERVER_URL'));
  const appServerCapability = required(env.ZEN_APP_SERVER_CAPABILITY, 'ZEN_APP_SERVER_CAPABILITY');
  if (
    Buffer.byteLength(appServerCapability, 'utf8') < 32 ||
    [...appServerCapability].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new Error('ZEN_APP_SERVER_CAPABILITY must be at least 32 bytes without whitespace');
  }
  const projectRoot = await realpath(resolve(env.IMZEN_PROJECT_ROOT || cwd));
  const qqApiBase = validateQQApiBase(env.IMZEN_QQ_API_BASE || DEFAULT_QQ_API_BASE);
  return {
    allowedUserIds: new Set(splitList(env.IMZEN_ALLOWED_USER_IDS)),
    appServerCapability,
    appServerUrl,
    dataDir: resolve(env.IMZEN_DATA_DIR || join(resolveAgentAppDataRoot(env), 'gateways', 'qq')),
    ...(env.IMZEN_PROJECT_ID?.trim() ? { projectId: env.IMZEN_PROJECT_ID.trim() } : {}),
    projectRoot,
    qqApiBase,
    qqCredential: await readQQBotCredential(secretFile),
    qqSecretFile: resolve(secretFile),
  };
}

export async function readQQBotCredential(path: string): Promise<QQBotCredential> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`Unable to read QQ credential file: ${resolve(path)}`, { cause });
  }
  if (!isRecord(value)) throw new Error('QQ credential file must contain one JSON object');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'appid' && key !== 'appsecret')) {
    throw new Error('QQ credential file contains unsupported fields');
  }
  const appId = String(value.appid ?? '').trim();
  const appSecret = typeof value.appsecret === 'string' ? value.appsecret.trim() : '';
  if (!/^\d+$/u.test(appId) || !appSecret) {
    throw new Error('QQ credential file requires numeric appid and non-empty appsecret');
  }
  return { appId, appSecret };
}

function validateQQApiBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !TRUSTED_QQ_API_HOSTS.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('IMZEN_QQ_API_BASE must be an official QQ HTTPS endpoint');
  }
  return url.origin;
}

function validateAppServerUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('ZEN_APP_SERVER_URL must be loopback HTTP or HTTPS without userinfo');
  }
  return url.href;
}

function splitList(value: string | undefined): readonly string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

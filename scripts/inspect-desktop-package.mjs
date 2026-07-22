import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listPackage } from '@electron/asar';

const DENIED_SEGMENTS = new Set([
  '.git',
  '.zen',
  'coverage',
  'journal',
  'journals',
  'secret',
  'secrets',
  'test',
  'tests',
  'tui',
]);
const RETIRED_MODULES = [
  'agent-interaction-session',
  'demo-runtime',
  'tui-legacy-client',
  'wait-graph',
];
const REQUIRED_ENTRIES = [
  'dist/main.js',
  'dist/preload.js',
  'dist/web/index.html',
  'node_modules/@zen/framework/dist/adapters/node/index.js',
];
export const MAX_DESKTOP_ASAR_BYTES = 12_000_000;
export const MAX_DESKTOP_ASAR_ENTRIES = 3_000;

export function findForbiddenAsarEntries(entries) {
  return entries.filter((entry) => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    const basename = segments.at(-1) ?? '';
    if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return true;
    if (RETIRED_MODULES.some((name) => basename.startsWith(`${name}.`))) return true;
    if (/(^|[-_.])terminal([-_.]|$)/u.test(basename)) return true;
    if (basename === '.env' || basename.startsWith('.env.')) return true;
    return /\.(jsonl|key|pem|pfx)$/u.test(basename);
  });
}

export function findMissingRequiredAsarEntries(entries) {
  const normalized = new Set(entries.map(normalizeEntry));
  return REQUIRED_ENTRIES.filter((entry) => !normalized.has(entry));
}

export async function inspectDesktopPackage(asarPath) {
  const resolved = resolve(asarPath);
  const packageStat = await stat(resolved);
  const entries = listPackage(resolved);
  const forbidden = findForbiddenAsarEntries(entries);
  if (forbidden.length > 0) {
    throw new Error(`Forbidden desktop package entries:\n${forbidden.join('\n')}`);
  }
  const missing = findMissingRequiredAsarEntries(entries);
  if (missing.length > 0) {
    throw new Error(`Missing desktop package entries:\n${missing.join('\n')}`);
  }
  assertDesktopPackageBounds({ bytes: packageStat.size, entries: entries.length });
  return { bytes: packageStat.size, entries: entries.length, asarPath: resolved };
}

export function assertDesktopPackageBounds({ bytes, entries }) {
  if (bytes > MAX_DESKTOP_ASAR_BYTES) {
    throw new Error(`Desktop ASAR is ${bytes} bytes; maximum is ${MAX_DESKTOP_ASAR_BYTES} bytes`);
  }
  if (entries > MAX_DESKTOP_ASAR_ENTRIES) {
    throw new Error(`Desktop ASAR has ${entries} entries; maximum is ${MAX_DESKTOP_ASAR_ENTRIES}`);
  }
}

function normalizeEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectDesktopPackage(
    process.argv[2] ?? 'apps/zenx/release/win-unpacked/resources/app.asar'
  );
  console.log(
    `Inspected ${result.entries} ASAR entries (${result.bytes} bytes): ${result.asarPath}`
  );
}

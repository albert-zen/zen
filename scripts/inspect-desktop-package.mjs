import { access } from 'node:fs/promises';
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

export async function inspectDesktopPackage(asarPath) {
  const resolved = resolve(asarPath);
  await access(resolved);
  const entries = listPackage(resolved);
  const forbidden = findForbiddenAsarEntries(entries);
  if (forbidden.length > 0) {
    throw new Error(`Forbidden desktop package entries:\n${forbidden.join('\n')}`);
  }
  return { entries: entries.length, asarPath: resolved };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectDesktopPackage(
    process.argv[2] ?? 'release/win-unpacked/resources/app.asar'
  );
  console.log(`Inspected ${result.entries} ASAR entries: ${result.asarPath}`);
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
  installCleanupHandlers,
  registerSpawnedProcess,
  terminateRegisteredProcess,
} from './owned-e2e-supervisor.mjs';

const marker = process.argv.find((argument) => argument.startsWith('--zen-e2e-run-marker='));
if (!marker) throw new Error('Owned Playwright launcher requires a Zen E2E run marker');
const runMarker = marker.slice(marker.indexOf('=') + 1);
process.env.ZEN_E2E_ROOT_PID = String(process.pid);

let child;
let registration;
let entry;
let cleanupStarted = false;
const cleanup = async () => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (!child) return;
  try {
    entry = await registration;
  } catch {
    return;
  }
  await terminateRegisteredProcess(entry);
};
const handlers = installCleanupHandlers(cleanup);

try {
  child = spawn(
    process.execPath,
    [
      `--title=${runMarker}-playwright`,
      path.join('node_modules', '@playwright', 'test', 'cli.js'),
      'test',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ZEN_E2E_RUN_MARKER: runMarker },
      stdio: 'inherit',
    }
  );
  const result = waitForChild(child);
  registration = registerSpawnedProcess({
    child,
    marker: runMarker,
    rootPid: process.pid,
    role: 'playwright-cli',
  });
  entry = await registration;
  if (cleanupStarted) {
    await terminateRegisteredProcess(entry);
  }
  const completed = await result;
  await cleanup();
  process.exitCode = completed.exitCode ?? (completed.signal ? 1 : 0);
} catch (cause) {
  await cleanup();
  throw cause;
} finally {
  handlers.dispose();
}

function waitForChild(startedChild) {
  return new Promise((resolve, reject) => {
    startedChild.once('error', reject);
    startedChild.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

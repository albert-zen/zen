import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const marker = process.argv.find((argument) => argument.startsWith('--zen-e2e-run-marker='));
if (!marker) throw new Error('Owned Playwright launcher requires a Zen E2E run marker');

const child = spawn(process.execPath, [path.join('node_modules', '@playwright', 'test', 'cli.js'), 'test'], {
  cwd: process.cwd(),
  env: { ...process.env, ZEN_E2E_RUN_MARKER: marker.slice(marker.indexOf('=') + 1) },
  stdio: 'inherit',
});

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
});

process.exitCode = result.exitCode ?? (result.signal ? 1 : 0);

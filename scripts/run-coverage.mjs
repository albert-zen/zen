import { spawn } from 'node:child_process';

const group = process.argv[2];
const groups = new Set(['kernel', 'product', 'presentation']);

if (!groups.has(group)) {
  throw new Error(`Expected a coverage group of ${[...groups].join(', ')}`);
}

const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--coverage',
    '--pool=forks',
    '--fileParallelism=false',
    '--maxWorkers=1'
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, COVERAGE_GROUP: group },
    stdio: 'inherit'
  }
);

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertNoOwnedProcesses, createRunMarker, runOwnedCommand } from './owned-e2e-supervisor.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const marker = createRunMarker();
const result = await runOwnedCommand({
  command: process.execPath,
  args: [
    `--title=${marker}-launcher`,
    path.join(scriptDirectory, 'run-playwright-child.mjs'),
    `--zen-e2e-run-marker=${marker}`,
  ],
  marker,
});

await assertNoOwnedProcesses();
process.exitCode = result.exitCode;

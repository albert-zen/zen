import { lstat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';

const OUTPUTS = {
  production: ['dist', 'web-dist', 'desktop-dist', 'release'],
  acceptance: ['dist/acceptance'],
};

export async function cleanGeneratedOutputs(root, mode) {
  const workspaceRoot = resolve(root);
  const outputs = OUTPUTS[mode];
  if (!outputs) throw new Error(`Unknown generated-output clean mode: ${mode}`);

  for (const output of outputs) {
    const target = resolve(workspaceRoot, output);
    const fromRoot = relative(workspaceRoot, target);
    if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('../')) {
      throw new Error(`Generated output escapes workspace root: ${output}`);
    }
    const stat = await lstat(target).catch((cause) => {
      if (cause?.code === 'ENOENT') return undefined;
      throw cause;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Generated output must be a real directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanGeneratedOutputs(process.cwd(), process.argv[2]);
}

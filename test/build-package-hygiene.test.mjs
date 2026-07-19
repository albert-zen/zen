import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanGeneratedOutputs } from '../scripts/clean-generated-outputs.mjs';
import {
  findForbiddenAsarEntries,
  findMissingRequiredAsarEntries,
} from '../scripts/inspect-desktop-package.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('production build and package hygiene', () => {
  it('removes only fixed generated directories and preserves runtime data', async () => {
    const root = await temporaryRoot();
    for (const output of ['dist', 'web-dist', 'desktop-dist', 'release']) {
      await mkdir(join(root, output), { recursive: true });
      await writeFile(join(root, output, 'stale-output.js'), 'stale');
    }
    await mkdir(join(root, '.zen'), { recursive: true });
    await writeFile(join(root, '.zen', 'projects.json'), '{}');

    await cleanGeneratedOutputs(root, 'production');

    for (const output of ['dist', 'web-dist', 'desktop-dist', 'release']) {
      await expect(stat(join(root, output))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(stat(join(root, '.zen', 'projects.json'))).resolves.toBeDefined();
  });

  it('rejects a generated-output path that is not a real directory', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'dist'), 'not a generated directory');
    await expect(cleanGeneratedOutputs(root, 'production')).rejects.toThrow(
      'must be a real directory'
    );
  });

  it('denies retired or sensitive package entries but retains active Executor modules', () => {
    const forbidden = [
      '/dist/tui/cli.js',
      '/dist/product/demo-runtime.js',
      '/dist/product/agent-interaction-session.js',
      '/test/server.test.js',
      '/coverage/index.html',
      '/runtime/threads/thread.jsonl',
      '/secrets/provider.key',
      '/node_modules/lucide-react/dist/esm/icons/terminal.mjs',
    ];
    const required = [
      '/dist/adapters/node/provider-runtime.js',
      '/dist/adapters/node/local-tool-runtime.js',
      '/dist/adapters/node/production-composition.js',
      '/dist/product/app-server.js',
      '/dist/product/app-server-protocol.js',
    ];

    expect(findForbiddenAsarEntries([...forbidden, ...required])).toEqual(forbidden);
  });

  it('requires the desktop entrypoints and root web document', () => {
    const required = ['/desktop-dist/main.js', '/desktop-dist/preload.js', '/web-dist/index.html'];

    expect(findMissingRequiredAsarEntries(required)).toEqual([]);
    expect(findMissingRequiredAsarEntries(required.slice(0, 2))).toEqual(['web-dist/index.html']);
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'zen-generated-output-'));
  roots.push(root);
  return root;
}

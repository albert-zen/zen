import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadImZenConfig, readQQBotCredential } from '../src/config.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  );
});

describe('IMZen configuration', () => {
  it('loads the external QQ secret without placing its value in config errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-config-'));
    roots.push(root);
    const secret = join(root, 'qq.json');
    await writeFile(secret, JSON.stringify({ appid: 123456, appsecret: 'very-private-value' }));

    await expect(readQQBotCredential(secret)).resolves.toEqual({
      appId: '123456',
      appSecret: 'very-private-value',
    });
    await expect(
      loadImZenConfig({
        IMZEN_QQ_SECRET_FILE: secret,
        ZEN_APP_SERVER_URL: 'http://127.0.0.1:3000',
        ZEN_APP_SERVER_CAPABILITY: 'x'.repeat(32),
        IMZEN_DATA_DIR: join(root, 'data'),
        IMZEN_PROJECT_ROOT: root,
      })
    ).resolves.toMatchObject({
      appServerUrl: 'http://127.0.0.1:3000/',
      projectRoot: root,
      qqSecretFile: secret,
    });
  });

  it('rejects untrusted QQ and insecure remote App Server endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imzen-config-'));
    roots.push(root);
    await mkdir(join(root, 'project'));
    const secret = join(root, 'qq.json');
    await writeFile(secret, JSON.stringify({ appid: 1, appsecret: 'secret' }));
    const base = {
      IMZEN_QQ_SECRET_FILE: secret,
      IMZEN_DATA_DIR: join(root, 'data'),
      ZEN_APP_SERVER_CAPABILITY: 'x'.repeat(32),
      IMZEN_PROJECT_ROOT: join(root, 'project'),
    };

    await expect(
      loadImZenConfig({ ...base, ZEN_APP_SERVER_URL: 'http://example.com:3000' })
    ).rejects.toThrow('loopback HTTP or HTTPS');
    await expect(
      loadImZenConfig({
        ...base,
        ZEN_APP_SERVER_URL: 'http://127.0.0.1:3000',
        IMZEN_QQ_API_BASE: 'https://example.com',
      })
    ).rejects.toThrow('official QQ HTTPS');
  });
});

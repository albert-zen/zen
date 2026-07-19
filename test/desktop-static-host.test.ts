import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveStaticRequest, serveDesktopStaticHost } from '../desktop/static-host.js';

describe('desktop static host', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
  });

  it('serves static files, SPA fallbacks, and never falls back for API routes', async () => {
    const root = await fixtureRoot(roots);
    const host = await serveDesktopStaticHost({
      staticRoot: root,
      apiTarget: 'http://127.0.0.1:1',
      capability: 'a'.repeat(32),
    });
    try {
      const asset = await fetch(new URL('/assets/app.js', host.url));
      expect(asset.headers.get('content-type')).toContain('application/javascript');
      expect(asset.headers.get('cache-control')).toContain('immutable');
      expect(await asset.text()).toBe('console.log(1)');

      const route = await fetch(new URL('/projects/one', host.url));
      expect(await route.text()).toContain('<div id="root"></div>');

      const api = await fetch(new URL('/request', host.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: host.url,
          'sec-fetch-site': 'same-origin',
        },
        body: '{}',
      });
      expect(api.status).toBe(502);
    } finally {
      await host.close();
    }
  });

  it('rejects forged authority, cross-origin fetch metadata, preflight, and non-json mutation', async () => {
    const root = await fixtureRoot(roots);
    const host = await serveDesktopStaticHost({
      staticRoot: root,
      apiTarget: 'http://127.0.0.1:1',
      capability: 'a'.repeat(32),
    });
    try {
      const cases = [
        { method: 'OPTIONS', headers: {} },
        { method: 'POST', headers: { origin: 'https://attacker.invalid' } },
        {
          method: 'POST',
          headers: {
            origin: host.url,
            'sec-fetch-site': 'cross-site',
            'content-type': 'application/json',
          },
        },
        {
          method: 'POST',
          headers: {
            origin: host.url,
            'sec-fetch-site': 'same-origin',
            'content-type': 'text/plain',
          },
        },
      ] as const;
      for (const input of cases) {
        const response = await fetch(new URL('/request', host.url), input);
        expect(response.status).toBe(403);
      }
      expect(
        await rawStatus(host.url, {
          Host: 'attacker.invalid',
          Origin: host.url,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        })
      ).toBe(403);
    } finally {
      await host.close();
    }
  });

  it('rejects traversal and keeps missing assets out of the SPA fallback', async () => {
    const root = await fixtureRoot(roots);
    expect(resolveStaticRequest(root, '/%2e%2e/secret.txt')).toEqual({ type: 'forbidden' });
    expect(resolveStaticRequest(root, '/assets/missing.js')).toEqual({ type: 'not-found' });
  });
});

async function fixtureRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zen-desktop-static-'));
  roots.push(root);
  await writeFile(join(root, 'index.html'), '<div id="root"></div>');
  await writeFile(join(root, 'assets-app.js'), 'console.log(1)');
  await (await import('node:fs/promises')).mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  return root;
}

async function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  const { request } = await import('node:http');
  const target = new URL('/request', url);
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    outgoing.once('error', reject);
    outgoing.end('{}');
  });
}

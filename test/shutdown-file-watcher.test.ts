import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchShutdownFile } from '../packages/framework/src/adapters/node/shutdown-file-watcher.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  );
});

describe('watchShutdownFile', () => {
  it('triggers once when an optional absolute marker file appears and disposes its interval', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'zen-shutdown-file-'));
    roots.push(root);
    const marker = join(root, 'stop.marker');
    const onShutdown = vi.fn();
    const watcher = watchShutdownFile({ markerPath: marker, onShutdown, pollIntervalMs: 25 });

    await vi.advanceTimersByTimeAsync(25);
    expect(onShutdown).not.toHaveBeenCalled();

    await writeFile(marker, '', 'utf8');
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(100);

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(watcher.requested).toBe(true);
    watcher.dispose();
  });

  it('does nothing when no marker path is configured', () => {
    const onShutdown = vi.fn();
    const watcher = watchShutdownFile({ onShutdown });

    expect(watcher.requested).toBe(false);
    watcher.dispose();
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('rejects non-absolute paths and non-file markers clearly', async () => {
    expect(() =>
      watchShutdownFile({ markerPath: 'relative.marker', onShutdown: () => undefined })
    ).toThrow('must be an absolute path');

    const root = await mkdtemp(join(tmpdir(), 'zen-shutdown-file-'));
    roots.push(root);
    const directoryMarker = join(root, 'directory-marker');
    await mkdir(directoryMarker);

    expect(() =>
      watchShutdownFile({ markerPath: directoryMarker, onShutdown: () => undefined })
    ).toThrow('must refer to a file');
  });
});

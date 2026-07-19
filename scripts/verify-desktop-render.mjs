import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

export async function verifyDesktopRender(options = {}) {
  const executablePath = resolve(options.executablePath ?? 'release/win-unpacked/Zen Agent.exe');
  const screenshotPath = options.screenshotPath ? resolve(options.screenshotPath) : undefined;
  const profileRoot = await mkdtemp(join(tmpdir(), 'zen-desktop-render-'));
  const environment = { ...process.env };
  delete environment.ZEN_DESKTOP_AUTO_QUIT_MS;
  delete environment.ZEN_DESKTOP_HIDE;

  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profileRoot}`],
    env: environment,
  });

  try {
    const window = await application.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.getByText('Zen control plane', { exact: true }).waitFor({ timeout: 30_000 });

    const body = await window.locator('body').innerText();
    const normalizedBody = body.toLowerCase();
    for (const expected of ['projects', 'threads', 'create a project']) {
      if (!normalizedBody.includes(expected)) {
        throw new Error(`Packaged desktop UI is missing expected content: ${expected}`);
      }
    }
    if (normalizedBody.includes('not found')) {
      throw new Error('Packaged desktop UI rendered an HTTP 404 response');
    }

    const viewport = await window.evaluate(() => ({
      height: globalThis.document.documentElement.clientHeight,
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      width: globalThis.document.documentElement.clientWidth,
    }));
    if (viewport.scrollWidth > viewport.width) {
      throw new Error(`Packaged desktop UI has horizontal overflow: ${JSON.stringify(viewport)}`);
    }

    if (screenshotPath) {
      await mkdir(dirname(screenshotPath), { recursive: true });
      await window.screenshot({ path: screenshotPath });
    }

    return {
      screenshotPath,
      title: await window.title(),
      url: window.url(),
      viewport,
    };
  } finally {
    await application.close().catch(() => undefined);
    await rm(profileRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyDesktopRender({
    executablePath: process.argv[2],
    screenshotPath: process.argv[3],
  });
  console.log(`Verified packaged desktop render: ${JSON.stringify(result)}`);
}

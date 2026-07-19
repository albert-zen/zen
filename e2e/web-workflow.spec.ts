import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { findOwnedProcesses } from '../scripts/owned-e2e-supervisor.mjs';
import { startFixtureServer } from './fixture-server.mjs';

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

test.beforeEach(async () => {
  fixture = await startFixtureServer();
});

test.afterEach(async () => {
  await fixture.close();
});

test('creates a project, parent thread, and human objective through the real Agent App HTTP/SSE path', async ({
  page,
}) => {
  const appRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/request' || url.pathname === '/events') appRequests.push(url.href);
  });
  await page.goto(`${fixture.origin}/web/`);
  const ownerMarker = process.env.ZEN_E2E_RUN_MARKER;
  if (ownerMarker) {
    const owned = await findOwnedProcesses(ownerMarker);
    expect(
      owned.some((entry) => entry.commandLine.includes(`--zen-e2e-owner=${ownerMarker}`))
    ).toBe(true);
  }
  await expect(page.getByRole('heading', { name: 'Create a project' })).toBeVisible();
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  await dialog.getByLabel('Name').fill('E2E project');
  await dialog.getByLabel('Root path').fill(fixture.projectRoot);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Projects' }).getByText('E2E project', { exact: true })
  ).toBeVisible();

  await page.getByRole('button', { name: 'New thread' }).click();
  const threadDialog = page.getByRole('dialog', { name: 'New thread' });
  await threadDialog.getByLabel('Objective').fill('Parent objective');
  await threadDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Threads' }).getByText('Parent objective', { exact: true })
  ).toBeVisible();
  await page.getByLabel('Message selected thread').fill('Human objective');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('main').getByText('Completed: thread turn', { exact: true })
  ).toBeVisible();
  expect(fixture.executionCount()).toBe(1);
  expect(appRequests.every((url) => new URL(url).origin === fixture.origin)).toBe(true);
  const artifacts = join(process.cwd(), 'docs', 'implementation', 'artifacts', 'agent-app');
  await mkdir(artifacts, { recursive: true });
  for (const [name, width, height] of [
    ['agent-app-1440x900.png', 1440, 900],
    ['agent-app-1728x1000.png', 1728, 1000],
    ['agent-app-390x844.png', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true);
    const nav = page.getByRole('navigation', { name: 'Mobile workspace views' });
    if (width < 768) {
      await expect(nav).toBeVisible();
      const box = await nav.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(width - 1);
    }
    await page.screenshot({ path: join(artifacts, name), fullPage: true });
  }
});

test('keeps project selection isolated across deep links and refresh', async ({ page }) => {
  const first = await fixture.request({
    method: 'project/create',
    params: {
      name: 'Second project',
      rootPath: `${fixture.projectRoot}-two`,
      idempotencyKey: 'second',
    },
  });
  expect(first.status).toBe(200);
  const projectId = first.body.result.project.id as string;
  const thread = await fixture.request({
    method: 'thread/create',
    params: { projectId, objective: 'Isolated objective', idempotencyKey: 'isolated-thread' },
  });
  const threadId = thread.body.result.thread.id as string;
  await page.goto(`${fixture.origin}/web/`);
  await page.goto(
    `${fixture.origin}/web/?project=${encodeURIComponent(projectId)}&thread=${encodeURIComponent(threadId)}`
  );
  await expect(
    page
      .getByRole('navigation', { name: 'Threads' })
      .getByText('Isolated objective', { exact: true })
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('navigation', { name: 'Threads' })
      .getByText('Isolated objective', { exact: true })
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('navigation', { name: 'Projects' }).getByText('Second project', { exact: true })
  ).toBeVisible();
});

test('returns typed request errors without duplicate side effects', async () => {
  const invalid = await fixture.request({ method: 'thread/create', params: {} });
  expect(invalid.status).toBe(400);
  expect(invalid.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  const projects = await fixture.request({ method: 'project/list', params: {} });
  expect(projects.body.result.projects).toHaveLength(0);
});

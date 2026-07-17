import { expect, test } from '@playwright/test';

import { startFixtureServer } from './fixture-server.mjs';

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

test('uses the same-origin proxy for streamed approval, reconnect, and thread resume', async ({
  page,
}) => {
  const appRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/request' || url.pathname === '/events') appRequests.push(url.href);
  });

  await page.goto(`${fixture.origin}/web/`);
  await expect(page.getByPlaceholder('Message Zen')).toBeEnabled();
  await page.getByPlaceholder('Message Zen').fill('approve the fixture command');
  await page.getByRole('button', { name: 'Send' }).click();
  await fixture.progress.waitForPending();

  await expect(page.getByText('Streamed assistant progress', { exact: true })).toBeVisible();
  await expect(page.getByText('Approved command complete', { exact: true })).toHaveCount(0);
  fixture.progress.releaseNext();

  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('fixture shell executed', { exact: true })).toBeVisible();
  await expect(page.getByText('Approved command complete', { exact: true })).toBeVisible();
  expect(fixture.executionCount()).toBe(1);
  expect(appRequests.length).toBeGreaterThan(1);
  expect(appRequests.every((url) => new URL(url).origin === fixture.origin)).toBe(true);

  await page.goto(`${fixture.origin}/web/?thread=thread-e2e-1`);
  await expect(page.getByText('Approved command complete', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Approved command complete', { exact: true })).toBeVisible();

  await page.getByText('Runtime', { exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Approved command complete', { exact: true })).toHaveCount(1);
});

test('declines a pending shell approval without executing the fixture tool', async ({ page }) => {
  const executionCount = fixture.executionCount();
  await page.goto(`${fixture.origin}/web/`);
  await expect(page.getByPlaceholder('Message Zen')).toBeEnabled();
  await page.getByPlaceholder('Message Zen').fill('decline the fixture command');
  await page.getByRole('button', { name: 'Send' }).click();
  await fixture.progress.waitForPending();
  await expect(page.getByText('Streamed assistant progress', { exact: true })).toBeVisible();
  fixture.progress.releaseNext();

  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(page.getByText('Tool call denied by policy: approval declined')).toBeVisible();
  await expect(page.getByText('Declined command was not executed', { exact: true })).toBeVisible();
  expect(fixture.executionCount()).toBe(executionCount);
});

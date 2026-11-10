// Browser check for live analytics, segments, webhooks and public reader pages.
// Run against a local server or deployment: LIVE_TEST_URL=... LIVE_TEST_CREDENTIALS=... node scratch/live-insights.mjs
import { chromium, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
const credentials = JSON.parse(readFileSync(process.env.LIVE_TEST_CREDENTIALS || '/tmp/beehiiv-live-browser-credentials.json', 'utf8'));
const origin = process.env.LIVE_TEST_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const unique = Date.now();
const segmentName = `VIP insights ${unique}`;
const hookName = `Insights hook ${unique}`;
const created = { subscribers: [], segment: null, webhook: null };
const apiCall = (method, path, data) => page.request.fetch(`${origin}/api${path}`, { method, headers: { origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { data }) });
const navigate = async name => {
  if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.locator('.live-sidebar nav').getByRole('button', { name, exact: true }).click();
};
try {
  mkdirSync('artifacts', { recursive: true });
  await page.goto(origin + '/?live=1');
  await page.getByLabel('Email address', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Welcome back/ })).toBeVisible();

  const readers = [{ tags: ['vip', 'insights'], source: 'Insights partner' }, { tags: ['insights'], source: 'Insights partner' }, { tags: [], source: 'Insights podcast', status: 'Unsubscribed' }];
  for (const [index, reader] of readers.entries()) {
    const response = await apiCall('POST', '/subscribers', { email: `insights-${unique}-${index}@example.org`, name: `Insights Reader ${index}`, source: reader.source, status: reader.status || 'Active', tags: reader.tags, consent: { source: 'browser-check' } });
    expect(response.status()).toBe(201); created.subscribers.push((await response.json()).id);
  }

  await navigate('Analytics');
  await expect(page.getByRole('heading', { name: 'See what’s resonating.' })).toBeVisible();
  const summary = await (await page.request.get(`${origin}/api/analytics/summary`)).json();
  await expect(page.locator('.live-metric').filter({ hasText: 'Active subscribers' }).locator('strong')).toHaveText(summary.subscribers.active.toLocaleString('en-US'));
  await expect(page.locator('.live-share-list')).toContainText('Insights partner');
  await expect(page.locator('.live-content')).not.toContainText('12,000');
  await page.screenshot({ path: 'artifacts/live-analytics-desktop.png', fullPage: true });
  console.log('PASS analytics tab shows stored subscriber and source totals, no demo figures');

  await navigate('Audience');
  await page.getByRole('button', { name: 'New segment', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create a segment' });
  await createDialog.getByLabel('Segment name').fill(segmentName);
  await createDialog.getByLabel('Condition 1 field').selectOption('tags');
  await createDialog.getByLabel('Condition 1 operator').selectOption('contains');
  await createDialog.getByLabel('Condition 1 value').fill('vip');
  await createDialog.getByRole('button', { name: 'Create segment', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Segment created');
  const segmentRow = page.locator('.live-segments-panel tbody tr').filter({ hasText: segmentName });
  await expect(segmentRow).toContainText('Tags include vip');
  await expect(segmentRow.locator('td').nth(1)).toHaveText('1');
  created.segment = (await (await page.request.get(`${origin}/api/segments?limit=100`)).json()).items.find(item => item.name === segmentName)?.id;
  await segmentRow.getByRole('button', { name: `Preview members of ${segmentName}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: `Members of ${segmentName}` })).toContainText(`insights-${unique}-0@example.org`);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await segmentRow.getByRole('button', { name: `Edit ${segmentName}`, exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit segment' });
  await editDialog.getByLabel('Readers must match').selectOption('any');
  await editDialog.getByRole('button', { name: 'Add condition', exact: true }).click();
  await editDialog.getByLabel('Condition 2 field').selectOption('source');
  await editDialog.getByLabel('Condition 2 operator').selectOption('equals');
  await editDialog.getByLabel('Condition 2 value').fill('Insights podcast');
  await editDialog.getByRole('button', { name: 'Save segment', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Segment saved');
  await expect(segmentRow.locator('td').nth(1)).toHaveText('2');
  await page.screenshot({ path: 'artifacts/live-segments-desktop.png', fullPage: true });
  console.log('PASS segment builder creates, counts, previews and edits a dynamic segment');

  await navigate('Developers');
  await page.getByRole('button', { name: 'Add endpoint', exact: true }).click();
  const hookDialog = page.getByRole('dialog', { name: 'Add a webhook endpoint' });
  await hookDialog.getByLabel('Name', { exact: true }).fill(hookName);
  await hookDialog.getByLabel('Endpoint URL').fill('https://localhost/private-hook');
  await hookDialog.getByRole('button', { name: 'Create endpoint', exact: true }).click();
  await expect(hookDialog.getByRole('alert')).toContainText('public HTTPS');
  await hookDialog.getByLabel('Endpoint URL').fill('https://example.com/newsletter-webhook-check');
  await hookDialog.getByLabel('subscriber.updated', { exact: true }).check();
  await hookDialog.getByRole('button', { name: 'Create endpoint', exact: true }).click();
  await expect(page.locator('.live-webhooks-panel .live-key-reveal code').last()).toContainText('whsec_');
  const hookRow = page.locator('.live-webhooks-panel tbody tr').filter({ hasText: hookName });
  await expect(hookRow).toContainText('subscriber.created, subscriber.updated');
  created.webhook = (await (await page.request.get(`${origin}/api/webhooks?limit=100`)).json()).items.find(item => item.name === hookName)?.id;
  await hookRow.getByRole('checkbox').uncheck(); await expect(hookRow).toContainText('Paused');
  await hookRow.getByRole('checkbox').check(); await expect(hookRow).toContainText('Active');
  await hookRow.getByRole('button', { name: `Delivery history for ${hookName}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: `Deliveries to ${hookName}` })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await hookRow.getByRole('button', { name: `Rotate secret for ${hookName}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Signing secret rotated');
  await page.screenshot({ path: 'artifacts/live-webhooks-desktop.png', fullPage: true });
  console.log('PASS webhook endpoint creation, one-time secret, pause/resume, history and rotation');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['Analytics', 'Audience', 'Developers']) {
    await navigate(tab);
    await page.waitForTimeout(150);
    const width = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
    expect(width.body, `${tab} should fit mobile viewport`).toBeLessThanOrEqual(width.viewport);
    await page.screenshot({ path: `artifacts/live-${tab.toLowerCase()}-mobile.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS new panels fit a 390px mobile viewport');

  const workspace = await (await page.request.get(`${origin}/api/workspace`)).json();
  const slug = workspace.data.publication.slug;
  await page.goto(`${origin}/api/public/${slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(workspace.data.publication.name);
  await page.screenshot({ path: 'artifacts/public-home.png', fullPage: true });
  await page.goto(`${origin}/api/public/${slug}/confirm?token=${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link can’t be used.');
  await expect(page.locator('body')).not.toContainText('"error"');
  await page.screenshot({ path: 'artifacts/public-invalid-confirmation.png', fullPage: true });
  console.log('PASS public publication home and friendly link error pages');
  expect(errors).toEqual([]);
  console.log('PASS no browser runtime errors');
} catch (error) {
  await page.screenshot({ path: 'artifacts/live-insights-failure.png', fullPage: true }).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created.webhook) await apiCall('DELETE', `/webhooks/${created.webhook}`).catch(() => {});
  if (created.segment) await apiCall('DELETE', `/segments/${created.segment}`).catch(() => {});
  for (const id of created.subscribers) await apiCall('DELETE', `/subscribers/${id}`).catch(() => {});
  await browser.close();
}

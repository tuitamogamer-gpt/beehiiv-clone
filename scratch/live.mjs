import { chromium, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
const credentials = JSON.parse(readFileSync(process.env.LIVE_TEST_CREDENTIALS || '/tmp/beehiiv-live-browser-credentials.json', 'utf8'));
const origin = process.env.LIVE_TEST_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const unique = Date.now();
const title = `Live browser test ${unique}`;
const subscriberEmail = `browser-${unique}@example.org`;
let postId;
let subscriberId;
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
  await expect(page.getByRole('heading', { name: 'Welcome back, Local.' })).toBeVisible();
  await expect(page.locator('.live-content')).not.toContainText('12,000');
  await page.screenshot({ path: 'artifacts/live-overview-desktop.png', fullPage: true });
  console.log('PASS real account login, empty publication, no sample audience metrics');

  await page.getByRole('button', { name: 'New post', exact: true }).click();
  await page.getByLabel('Post title', { exact: true }).fill(title);
  await page.getByLabel('Preview text', { exact: true }).fill('Saved through the live publishing API.');
  await page.getByRole('textbox', { name: 'Newsletter content', exact: true }).fill('Hello {{first_name}}, this issue is stored on the server.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Post saved');
  await page.reload();
  await navigate('Posts');
  await page.locator('.live-table-link').filter({hasText:title}).click();
  await expect(page.getByLabel('Post title', { exact: true })).toHaveValue(title);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Rendered newsletter"]').locator('body')).toContainText('Hello Preview');
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Schedule newsletter', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Email delivery and scheduled jobs must be configured');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Schedule newsletter', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  console.log('PASS API-backed post creation, reload persistence, rendered preview, explicit unavailable-send state');

  await navigate('Audience');
  await page.getByRole('button', { name: 'Add subscriber', exact: true }).click();
  await page.getByLabel('Full name', { exact: true }).fill('Browser Test Reader');
  await page.getByLabel('Email address', { exact: true }).fill(subscriberEmail);
  await page.getByLabel('Tags, separated by commas', { exact: true }).fill('verified, browser');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save subscriber', exact: true }).click();
  await expect(page.locator('.live-table')).toContainText(subscriberEmail);
  await page.reload();
  await navigate('Audience');
  await page.getByRole('button', { name: `Browser Test Reader ${subscriberEmail}`, exact: false }).click();
  await expect(page.getByLabel('Tags, separated by commas')).toHaveValue('verified, browser');
  await page.getByLabel('Status', { exact: true }).selectOption('Unsubscribed');
  await page.getByRole('button', { name: 'Save subscriber', exact: true }).click();
  await expect(page.locator('.live-table tr').filter({ hasText: subscriberEmail })).toContainText('Unsubscribed');
  console.log('PASS subscriber creation, consent, tags, persisted reload and status update');

  await navigate('Developers');
  await page.getByLabel('Key name', { exact: true }).fill('Live browser verification');
  await page.getByRole('button', { name: 'Create key · expires in 90 days', exact: true }).click();
  await expect(page.locator('.live-key-reveal code')).toBeVisible();
  const rawKey = await page.locator('.live-key-reveal code').textContent();
  const authenticated = await page.request.get(origin + '/api/posts', { headers: { authorization: `Bearer ${rawKey}` } });
  expect(authenticated.status()).toBe(200);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('API key revoked');
  const revoked = await page.request.get(origin + '/api/posts', { headers: { authorization: `Bearer ${rawKey}` } });
  expect(revoked.status()).toBe(401);
  console.log('PASS actual scoped API key creation, bearer authentication and immediate revocation');

  const workspace = await (await page.request.get(origin + '/api/workspace')).json();
  postId = workspace.data.posts.find(post => post.title === title)?.id;
  subscriberId = workspace.data.subscribers.find(subscriber => subscriber.email === subscriberEmail)?.id;
  expect(postId).toBeTruthy(); expect(subscriberId).toBeTruthy();
  await navigate('Overview');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.live-content')).toContainText('Welcome back, Local.');
  await page.screenshot({ path: 'artifacts/live-overview-mobile.png', fullPage: true });
  for (const tab of ['Posts', 'Audience', 'Settings', 'Developers', 'Overview']) {
    await navigate(tab);
    const width = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
    expect(width.body, `${tab} should fit mobile viewport`).toBeLessThanOrEqual(width.viewport);
  }
  console.log('PASS live mobile navigation and no horizontal overflow on all pages');

  page.on('dialog', dialog => dialog.accept());
  await navigate('Audience');
  await page.getByRole('button', { name: `Delete ${subscriberEmail}`, exact: true }).click();
  await expect(page.locator('.live-table')).not.toContainText(subscriberEmail);
  subscriberId = undefined;
  await navigate('Posts');
  await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(page.locator('.live-table')).not.toContainText(title);
  postId = undefined;
  await page.reload();
  const finalWorkspace = await (await page.request.get(origin + '/api/workspace')).json();
  expect(finalWorkspace.data.posts.some(post => post.title === title)).toBe(false);
  expect(finalWorkspace.data.subscribers.some(subscriber => subscriber.email === subscriberEmail)).toBe(false);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to your workspace.' })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS permanent deletes survive reload and sign-out revokes session; no browser runtime errors');
} catch (error) {
  await page.screenshot({ path: 'artifacts/live-failure.png', fullPage: true });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { const remaining = await (await page.request.get(origin + '/api/workspace')).json(); postId = remaining.data?.posts.find(post => post.title === title)?.id; subscriberId = remaining.data?.subscribers.find(subscriber => subscriber.email === subscriberEmail)?.id; } catch {}
  for (const path of [postId && `/posts/${postId}`, subscriberId && `/subscribers/${subscriberId}`].filter(Boolean)) await page.request.delete(origin + '/api' + path, { headers: { origin } }).catch(() => {});
  await browser.close();
}

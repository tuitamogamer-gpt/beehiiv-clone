import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { config } from '../core/config.js';
import { hash } from '../core/http.js';
import { bootstrapAdmin } from '../modules/auth.js';
import { saveMedia } from '../modules/media.js';

async function fixture(t: TestContext) {
  const store = await createSqliteStore(), services = createServices(store), app = createApp(services);
  const owner = await bootstrapAdmin(store, { email: 'media-tests@example.com', password: 'media-test-password-1234', name: 'Media Owner', publicationName: 'Media Publication' });
  t.after(async () => { await rm(`.data/media/${owner.tenantId}`, { recursive: true, force: true }); await store.close(); });
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(config.appUrl).origin }, body: JSON.stringify({ email: 'media-tests@example.com', password: 'media-test-password-1234' }) }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => app.request('/api' + path, { method, headers: { cookie, origin: new URL(config.appUrl).origin, 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, services, app, owner, cookie, request };
}

test('public image publication rotates and revokes capability links without losing private access', async t => {
  const f = await fixture(t), bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#12aabb' } }).png().toBuffer();
  const row = await saveMedia(f.services, f.owner.tenantId, f.owner.userId, bytes, 'public-test.png', 'image/png');
  assert.equal((await f.app.request(`/api/public/media/${f.owner.tenantId}/${row.id}/made-up-token`)).status, 404);
  const publication = await f.request(`/media/${row.id}/publish`, 'POST', {}); assert.equal(publication.status, 200); const first = await publication.json(); const firstPath = new URL(first.url).pathname;
  const publicImage = await f.app.request(firstPath); assert.equal(publicImage.status, 200); assert.equal(publicImage.headers.get('content-type'), 'image/webp'); assert.equal(publicImage.headers.get('x-content-type-options'), 'nosniff'); assert.match(publicImage.headers.get('content-security-policy')!, /sandbox/); assert.equal((await sharp(Buffer.from(await publicImage.arrayBuffer())).metadata()).width, 24);
  const saved = await f.store.get(f.owner.tenantId, 'media', row.id), token = firstPath.split('/').at(-1)!; assert.equal(saved?.data.publicTokenHash, hash(token)); assert.ok(!JSON.stringify(saved?.data).includes(token));
  const rotated = await (await f.request(`/media/${row.id}/publish`, 'POST', {})).json(); assert.notEqual(rotated.url, first.url); assert.equal((await f.app.request(firstPath)).status, 404); assert.equal((await f.app.request(new URL(rotated.url).pathname)).status, 200);
  assert.equal((await f.request(`/media/${row.id}/public`, 'DELETE')).status, 204); assert.equal((await f.app.request(new URL(rotated.url).pathname)).status, 404); assert.equal((await f.request(`/media/${row.id}/content`)).status, 200);
});

test('public capability does not cross tenants or publish private PDFs and text', async t => {
  const f = await fixture(t);
  for (const [name, mime, bytes] of [['private.pdf', 'application/pdf', '%PDF-1.7\nconfidential invoice'], ['private.txt', 'text/plain', 'confidential account notes']]) {
    const row = await saveMedia(f.services, f.owner.tenantId, f.owner.userId, Buffer.from(bytes), name, mime);
    assert.equal((await f.request(`/media/${row.id}/publish`, 'POST', {})).status, 422);
    const token = 'a-test-token-intentionally-added-to-a-non-public-record'; await f.store.update(f.owner.tenantId, 'media', row.id, { ...row.data, publicTokenHash: hash(token) }, row.version);
    const response = await f.app.request(`/api/public/media/${f.owner.tenantId}/${row.id}/${token}`); assert.equal(response.status, 404); assert.ok(!(await response.text()).includes('confidential'));
    assert.equal((await f.app.request(`/api/public/media/another-publication/${row.id}/${token}`)).status, 404); assert.equal((await f.app.request(`/api/media/${row.id}/content`)).status, 401);
  }
});

test('public audio requires an explicit link and publishing remains API-scope protected', async t => {
  const f = await fixture(t), row = await saveMedia(f.services, f.owner.tenantId, f.owner.userId, Buffer.from('ID3-test-audio-payload'), 'audio.mp3', 'audio/mpeg');
  const key = await (await f.request('/api-keys', 'POST', { name: 'Read media only', scopes: ['media:read'] })).json();
  const forbidden = await f.app.request(`/api/media/${row.id}/publish`, { method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: '{}' }); assert.equal(forbidden.status, 403);
  const published = await (await f.request(`/media/${row.id}/publish`, 'POST', {})).json(); const response = await f.app.request(new URL(published.url).pathname); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/mpeg'); assert.equal(await response.text(), 'ID3-test-audio-payload');
  const deleted = await f.request(`/media/${row.id}`, 'DELETE'); assert.equal(deleted.status, 204); assert.equal((await f.app.request(new URL(published.url).pathname)).status, 404);
});

test('webhook management mutations enforce same-origin cookie requests before parsing bodies', async t => {
  const f = await fixture(t);
  for (const [method, path] of [['PATCH', '/webhooks/example'], ['DELETE', '/webhooks/example'], ['POST', '/webhooks/example/rotate-secret']]) {
    const response = await f.app.request('/api' + path, { method, headers: { cookie: f.cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: 'not valid JSON' }); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'invalid_origin');
  }
});

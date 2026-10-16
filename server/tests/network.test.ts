import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../core/http.js';
import { isPrivateAddress, validatePublicUrl } from '../core/network.js';

test('SSRF address checks reject private IPv4, IPv6 and IPv4-mapped IPv6 addresses', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:1',
    '0:0:0:0:0:ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::',
  ]) assert.equal(isPrivateAddress(address), true, `Must reject ${address}`);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, `Expected public address ${address}`);
  }
});

test('public URL validation rejects localhost aliases, mapped loopback, credentials, non-HTTPS and alternate ports', async () => {
  for (const url of [
    'http://example.com', 'https://user:password@example.com', 'https://example.com:444',
    'https://localhost', 'https://service.local', 'https://service.internal',
    'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://0x7f000001',
    'https://[::1]', 'https://[0:0:0:0:0:0:0:1]',
    'https://[::ffff:127.0.0.1]', 'https://[::ffff:7f00:1]', 'https://[::ffff:10.0.0.1]',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    await assert.rejects(validatePublicUrl(url), (error: unknown) => error instanceof ApiError && error.code === 'unsafe_url', `Must reject ${url}`);
  }
});

test('literal public HTTPS destinations validate without following paths or redirects', async () => {
  const result = await validatePublicUrl('https://8.8.8.8:443/webhook?next=https://127.0.0.1');
  assert.equal(result.url.protocol, 'https:');
  assert.equal(result.url.hostname, '8.8.8.8');
  assert.deepEqual(result.addresses, [{ address: '8.8.8.8', family: 4 }]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { attachmentDisposition, hashLinkPassword, safeEqual, verifyLinkPassword } from '../netlify/lib/security.js';

test('scrypt link passwords verify and are salted', async () => {
  const a = await hashLinkPassword('hunter2-long');
  const b = await hashLinkPassword('hunter2-long');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(await verifyLinkPassword('hunter2-long', a), true);
  assert.equal(await verifyLinkPassword('wrong', a), false);
});

test('legacy sha256 hashes from existing links still verify', async () => {
  const legacy = createHash('sha256').update('old-pass').digest('hex');
  assert.equal(await verifyLinkPassword('old-pass', legacy), true);
  assert.equal(await verifyLinkPassword('nope', legacy), false);
});

test('garbage stored hashes never verify', async () => {
  assert.equal(await verifyLinkPassword('x', ''), false);
  assert.equal(await verifyLinkPassword('x', 'scrypt$bad$bad'), false);
});

test('safeEqual', () => {
  assert.equal(safeEqual('admin', 'admin'), true);
  assert.equal(safeEqual('admin', 'admin2'), false);
});

test('content-disposition cannot be broken out of', () => {
  const d = attachmentDisposition('evil"; filename=x.html\r\nX: y.txt');
  assert.ok(!/[\r\n]/.test(d));
  assert.match(d, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
});

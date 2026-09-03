import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, generateVapidKeys, vapidAuthorization, b64u } from '../src/push.js';

test('payload encrypted with WebCrypto decrypts with an independent RFC 8291 implementation', async () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16);
  const subscription = {
    endpoint: 'https://push.example.org/send/abc',
    keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(auth) },
  };
  const message = JSON.stringify({ title: 'Wash the car', body: '8:00 PM' });
  const body = await encryptPayload(subscription, message);
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: receiver, authSecret: b64u(auth) });
  assert.equal(plain.toString('utf8'), message);
});

test('VAPID header carries an ES256 JWT for the push origin', async () => {
  const keys = await generateVapidKeys();
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/xyz', 'mailto:owner@example.com', keys);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'header shape');
  const [h, p, s] = m[1].split('.');
  const decode = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(decode(h), { typ: 'JWT', alg: 'ES256' });
  assert.equal(decode(p).aud, 'https://fcm.googleapis.com');
  assert.equal(decode(p).sub, 'mailto:owner@example.com');
  assert.equal(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 64);
  assert.equal(m[2], keys.publicKey);
});

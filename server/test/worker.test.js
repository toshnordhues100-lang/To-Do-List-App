import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

const token = 'abcdefghijklmnopqrstuvwxyz012345';

test('device subscription and reminders round-trip through KV', async () => {
  const env = { KV: fakeKV(), ALLOWED_ORIGIN: '*' };
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } };
  let res = await worker.fetch(new Request(`https://api/api/devices/${token}`, { method: 'PUT', body: JSON.stringify({ subscription: sub, tz: 'America/Chicago' }) }), env);
  assert.equal(res.status, 200);
  res = await worker.fetch(new Request(`https://api/api/devices/${token}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders: [{ id: 't1', title: 'Wash the car', body: '8:00 PM', at: '2026-09-05T01:00:00.000Z' }, { id: 'bad', title: 'x', at: 'nope' }] }) }), env);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, reminders: 1, subscribed: true });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const stored = JSON.parse(env.KV.m.get(`dev:${token}`));
  assert.equal(stored.subscription.endpoint, sub.endpoint);
  assert.equal(stored.reminders[0].at, '2026-09-05T01:00:00.000Z');
});

test('vapid key is generated once and reused', async () => {
  const env = { KV: fakeKV() };
  const a = await (await worker.fetch(new Request('https://api/api/vapid'), env)).json();
  const b = await (await worker.fetch(new Request('https://api/api/vapid'), env)).json();
  assert.equal(a.publicKey, b.publicKey);
  assert.ok(a.publicKey.length > 80);
});

test('parse rejects bad input and enforces the daily cap without calling Claude', async () => {
  const env = { KV: fakeKV(), ANTHROPIC_API_KEY: 'k', PARSE_DAILY_LIMIT: '1' };
  let res = await worker.fetch(new Request('https://api/api/parse', { method: 'POST', body: JSON.stringify({ text: '' }) }), env);
  assert.equal(res.status, 400);
  res = await worker.fetch(new Request('https://api/api/parse', { method: 'POST', body: JSON.stringify({ text: 'hi' }) }), env);
  assert.equal(res.status, 400);
  await env.KV.put(`rl:${token}:${new Date().toISOString().slice(0, 10)}`, '1');
  res = await worker.fetch(new Request('https://api/api/parse', { method: 'POST', body: JSON.stringify({ text: 'hi', token }) }), env);
  assert.equal(res.status, 429);
});

test('unknown routes 404 and OPTIONS answers CORS', async () => {
  const env = { KV: fakeKV() };
  assert.equal((await worker.fetch(new Request('https://api/nope'), env)).status, 404);
  const pre = await worker.fetch(new Request('https://api/api/parse', { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Methods').includes('PUT'), true);
});

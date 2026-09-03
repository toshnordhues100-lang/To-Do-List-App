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

test('status and test endpoints report the push pipeline', async () => {
  const env = { KV: fakeKV(), ALLOWED_ORIGIN: '*' };
  const sub = { endpoint: 'https://web.push.apple.com/QW', keys: { p256dh: 'BNo', auth: 'x' } };
  let res = await worker.fetch(new Request(`https://api/api/devices/${token}`), env);
  assert.deepEqual(await res.json(), { subscribed: false, pushService: null, scheduled: 0, next: null, lastDelivery: null, lastTest: null, updatedAt: null });
  res = await worker.fetch(new Request(`https://api/api/devices/${token}/test`, { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 400);
  await worker.fetch(new Request(`https://api/api/devices/${token}`, { method: 'PUT', body: JSON.stringify({ subscription: sub }) }), env);
  res = await worker.fetch(new Request(`https://api/api/devices/${token}`), env);
  const st = await res.json();
  assert.equal(st.subscribed, true);
  assert.equal(st.pushService, 'web.push.apple.com');
});

import { deliverDue } from '../src/index.js';
import { createECDH, randomBytes } from 'node:crypto';
import { b64u } from '../src/push.js';

// A real P-256 subscription, so the push payload is genuinely encrypted in these tests.
function realSubscription() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  return { endpoint: 'https://web.push.apple.com/QW', keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(randomBytes(16)) } };
}

// Records what the push service was asked to send, and when, without leaving the machine.
function pushRecorder() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), at: Date.now(), ttl: init.headers.TTL, urgency: init.headers.Urgency });
    return new Response('', { status: 201 });
  };
  return calls;
}

async function deviceWithReminder(env, at) {
  await worker.fetch(new Request(`https://api/api/devices/${token}`, { method: 'PUT', body: JSON.stringify({ subscription: realSubscription() }) }), env);
  await worker.fetch(new Request(`https://api/api/devices/${token}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders: [{ id: 't1', title: 'Take out the trash', body: '11:10 PM', at }] }) }), env);
}

test('a reminder coming up is claimed now and pushed at its exact second', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    const calls = pushRecorder();
    const now = new Date();
    // Due 40 seconds from now: the old code would have waited for the next minute tick.
    await deviceWithReminder(env, new Date(now.getTime() + 40000).toISOString());
    const waits = [];
    const sent = await deliverDue(env, now, { wait: async (ms) => { waits.push(ms); } });
    assert.equal(sent, 1, 'pushed within this run rather than a later tick');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].urgency, 'high');
    // It waited for the remaining time instead of firing early.
    assert.ok(waits.length === 1 && waits[0] > 30000 && waits[0] <= 40000, `waited ${waits[0]}ms`);
  } finally { globalThis.fetch = realFetch; }
});

test('the next run does not send the same reminder again', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    const calls = pushRecorder();
    const now = new Date();
    await deviceWithReminder(env, new Date(now.getTime() + 20000).toISOString());
    await deliverDue(env, now, { wait: async () => {} });
    await deliverDue(env, new Date(now.getTime() + 60000), { wait: async () => {} });
    assert.equal(calls.length, 1, 'claimed on the first run, skipped on the second');
  } finally { globalThis.fetch = realFetch; }
});

test('a reminder missed while the server was down still goes out, but stale ones do not', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    const calls = pushRecorder();
    const now = new Date();
    await deviceWithReminder(env, new Date(now.getTime() - 5 * 60000).toISOString());
    assert.equal(await deliverDue(env, now, { wait: async () => {} }), 1, 'five minutes late is still worth sending');
    const env2 = { KV: fakeKV() };
    await deviceWithReminder(env2, new Date(now.getTime() - 45 * 60000).toISOString());
    assert.equal(await deliverDue(env2, now, { wait: async () => {} }), 0, 'forty-five minutes late is not');
  } finally { globalThis.fetch = realFetch; }
});

test('the delivery outcome is recorded for the status readout', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    pushRecorder();
    const now = new Date();
    await deviceWithReminder(env, new Date(now.getTime() + 1000).toISOString());
    await deliverDue(env, now, { wait: async () => {} });
    const st = await (await worker.fetch(new Request(`https://api/api/devices/${token}`), env)).json();
    assert.equal(st.lastDelivery.title, 'Take out the trash');
    assert.equal(st.lastDelivery.status, 201);
    assert.equal(st.lastDelivery.ok, true);
  } finally { globalThis.fetch = realFetch; }
});

test('a reminder due in the next two minutes is pushed by the sync request itself, not the scheduler', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    const calls = pushRecorder();
    await worker.fetch(new Request(`https://api/api/devices/${token}`, { method: 'PUT', body: JSON.stringify({ subscription: realSubscription() }) }), env);
    const background = [];
    const ctx = { waitUntil: (p) => background.push(p) };
    const at = new Date(Date.now() + 300).toISOString();
    const res = await worker.fetch(new Request(`https://api/api/devices/${token}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders: [{ id: 'soon', title: 'Clean', body: 'now', at }] }) }), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(background.length, 1, 'delivery was scheduled in the background of the request');
    await Promise.all(background);
    assert.equal(calls.length, 1, 'pushed without waiting for a cron tick');
    assert.ok(calls[0].at >= Date.parse(at) - 5, 'not before its moment');
    const st = await (await worker.fetch(new Request(`https://api/api/devices/${token}`), env)).json();
    assert.equal(st.lastDelivery.title, 'Clean');
  } finally { globalThis.fetch = realFetch; }
});

test('a reminder far in the future is left to the scheduler', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    const calls = pushRecorder();
    await worker.fetch(new Request(`https://api/api/devices/${token}`, { method: 'PUT', body: JSON.stringify({ subscription: realSubscription() }) }), env);
    const background = [];
    await worker.fetch(new Request(`https://api/api/devices/${token}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders: [{ id: 'later', title: 'Dentist', body: '', at: new Date(Date.now() + 3600000).toISOString() }] }) }), env, { waitUntil: (p) => background.push(p) });
    await Promise.all(background);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

// Cloudflare's free plan allows roughly 1,000 writes and 1,000 list calls a day.
// These tests pin the storage cost of the paths that run all day long.
function countingKV() {
  const kv = fakeKV();
  kv.ops = { get: 0, put: 0, list: 0, delete: 0 };
  for (const op of ['get', 'put', 'list', 'delete']) {
    const real = kv[op].bind(kv);
    kv[op] = async (...a) => { kv.ops[op] += 1; return real(...a); };
  }
  return kv;
}

test('an idle scheduler minute costs one read: no listing, no writes', async () => {
  const env = { KV: countingKV() };
  const now = new Date();
  await deviceWithReminder(env, new Date(now.getTime() + 3600000).toISOString());
  await deliverDue(env, now, { wait: async () => {} }); // first run builds the index
  env.KV.ops = { get: 0, put: 0, list: 0, delete: 0 };
  for (let m = 1; m <= 30; m += 1) {
    await deliverDue(env, new Date(now.getTime() + m * 60000), { wait: async () => {} });
  }
  assert.deepEqual(env.KV.ops, { get: 30, put: 0, list: 0, delete: 0 });
});

test('a phone missing from the index is picked up by the hourly rebuild', async () => {
  const env = { KV: fakeKV() };
  const realFetch = globalThis.fetch;
  try {
    const calls = pushRecorder();
    const now = new Date();
    await deviceWithReminder(env, new Date(now.getTime() + 62 * 60000).toISOString());
    await env.KV.put('idx', JSON.stringify({ rebuilt: now.toISOString(), devices: {} })); // simulate a lost update
    assert.equal(await deliverDue(env, new Date(now.getTime() + 20 * 60000), { wait: async () => {} }), 0, 'index still fresh, phone unknown');
    assert.equal(await deliverDue(env, new Date(now.getTime() + 61 * 60000), { wait: async () => {} }), 1, 'rebuilt after an hour and caught up');
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('the daily Claude budget is persisted every 25th command, not every command', async () => {
  const env = { KV: countingKV(), ANTHROPIC_API_KEY: 'k', PARSE_DAILY_LIMIT: '400' };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"actions":[],"say":"ok"}' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const other = 'zyxwvutsrqponmlkjihgfedcba543210';
    for (let i = 0; i < 50; i += 1) {
      const res = await worker.fetch(new Request('https://api/api/parse', { method: 'POST', body: JSON.stringify({ text: 'buy milk', token: other }) }), env);
      assert.equal(res.status, 200);
    }
    assert.equal(env.KV.ops.put, 2);
    assert.equal(env.KV.m.get(`rl:${other}:${new Date().toISOString().slice(0, 10)}`), '50');
  } finally { globalThis.fetch = realFetch; }
});

test('subscription and reminders arrive in one request and cost one device write', async () => {
  const env = { KV: countingKV() };
  const res = await worker.fetch(new Request(`https://api/api/devices/${token}/reminders`, { method: 'PUT', body: JSON.stringify({ subscription: realSubscription(), tz: 'America/Chicago', reminders: [{ id: 'a', title: 'Dentist', body: '', at: new Date(Date.now() + 7200000).toISOString() }] }) }), env, { waitUntil: () => {} });
  assert.deepEqual(await res.json(), { ok: true, reminders: 1, subscribed: true });
  assert.equal(env.KV.ops.put, 2, 'the device and the index');
  const again = await worker.fetch(new Request(`https://api/api/devices/${token}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders: [{ id: 'a', title: 'Dentist', body: '', at: new Date(Date.now() + 7200000).toISOString() }] }) }), env, { waitUntil: () => {} });
  assert.equal((await again.json()).subscribed, true, 'the stored subscription is kept when only reminders are sent');
});

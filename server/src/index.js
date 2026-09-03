// Cadence API: a Cloudflare Worker that gives the app two things a static site
// cannot do on its own.
//
//   POST /api/parse                      Claude turns speech into task actions
//   GET  /api/vapid                      public key for push subscriptions
//   PUT  /api/devices/:token             store this phone's push subscription
//   PUT  /api/devices/:token/reminders   replace this phone's reminder schedule
//   DELETE /api/devices/:token           forget this phone
//   cron every minute                    send the reminders that are due, to the second
//
// Storage is a KV namespace. Devices are identified by a random token the app
// generates; nothing personal is stored beyond task titles for reminders.

import Anthropic from '@anthropic-ai/sdk';
import { parseUtterance } from './parse.js';
import { generateVapidKeys, sendPush } from './push.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function cors(env, extra = {}) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors(env, { 'Content-Type': 'application/json' }) });

// KV on the free plan allows about 1,000 writes and 1,000 list calls a day, so the
// worker is careful: keys are cached in memory, the scheduler reads one small index
// instead of listing every device, and counters are persisted only now and then.
let vapidCache = null;
async function vapid(env) {
  if (vapidCache) return vapidCache;
  let keys = await env.KV.get('vapid', 'json');
  if (!keys) {
    keys = await generateVapidKeys();
    await env.KV.put('vapid', JSON.stringify(keys));
  }
  vapidCache = keys;
  return keys;
}

// Daily Claude budget per phone. Counted in memory and written to KV every 25th
// call (and at the cap), so a busy phone costs a handful of writes a day, not one
// per command. The count survives a restart to within 25 commands.
const budget = new Map();
async function takeParseSlot(env, token, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${token}:${day}`;
  let used = budget.get(key);
  if (used === undefined) {
    used = Number(await env.KV.get(key)) || 0;
    for (const k of budget.keys()) if (!k.endsWith(day)) budget.delete(k);
  }
  if (used >= limit) return false;
  used += 1;
  budget.set(key, used);
  if (used % 25 === 0 || used >= limit) await env.KV.put(key, String(used), { expirationTtl: 2 * 86400 });
  return true;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function handleParse(request, env) {
  const body = await readJson(request);
  if (!body || typeof body.text !== 'string' || !body.text.trim()) return json(env, { error: 'text required' }, 400);
  const token = String(body.token || '');
  if (!TOKEN_RE.test(token)) return json(env, { error: 'token required' }, 400);
  if (!env.ANTHROPIC_API_KEY) return json(env, { error: 'server has no ANTHROPIC_API_KEY' }, 503);

  // Daily cap per device keeps the bill predictable.
  const limit = Number(env.PARSE_DAILY_LIMIT) || 400;
  if (!(await takeParseSlot(env, token, limit))) return json(env, { error: 'daily limit reached' }, 429);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20000 });
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 120).map((t) => ({ id: String(t.id || ''), title: String(t.title || '').slice(0, 120), due: t.due || null, time: t.time || null })) : [];
  try {
    const result = await parseUtterance({
      text: body.text.slice(0, 1000),
      nowIso: typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? body.now : new Date().toISOString(),
      tz: typeof body.tz === 'string' && body.tz.length < 64 ? body.tz : 'UTC',
      tasks,
    }, client);
    return json(env, { actions: result.actions, say: result.say, ok: result.ok });
  } catch (e) {
    const status = e && typeof e.status === 'number' ? e.status : 502;
    return json(env, { error: status === 401 ? 'invalid API key' : status === 429 ? 'Claude is rate limited' : 'Claude request failed' }, status === 429 ? 429 : 502);
  }
}

function deviceKey(token) { return `dev:${token}`; }

// The index is one small KV value: for every phone, when its next unsent reminder
// is due. The scheduler reads it once a minute and only opens the phones that have
// something due, instead of listing and reading every phone every minute.
const INDEX_KEY = 'idx';
const REBUILD_MS = 60 * 60000;
const LATE_LIMIT_MS = 30 * 60000; // never fire reminders more than 30 min late

function nextUnsent(dev, nowMs = Date.now()) {
  if (!dev || !dev.subscription || !Array.isArray(dev.reminders)) return null;
  let best = null;
  for (const r of dev.reminders) {
    const t = Date.parse(r.at);
    if (Number.isNaN(t) || t <= nowMs - LATE_LIMIT_MS) continue;
    if (dev.sent && dev.sent[`${r.id}@${r.at}`]) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

async function readIndex(env) {
  const idx = await env.KV.get(INDEX_KEY, 'json');
  return idx && typeof idx === 'object' && idx.devices ? idx : { rebuilt: null, devices: {} };
}

// One write, and only when this phone's entry actually changed.
async function updateIndex(env, key, dev) {
  const idx = await readIndex(env);
  const next = dev ? nextUnsent(dev) : undefined;
  const had = Object.prototype.hasOwnProperty.call(idx.devices, key);
  if (next === undefined ? !had : had && idx.devices[key] === next) return idx;
  if (next === undefined) delete idx.devices[key];
  else idx.devices[key] = next;
  await env.KV.put(INDEX_KEY, JSON.stringify(idx));
  return idx;
}

// Once an hour the index is rebuilt from a full listing, so a phone that slipped
// out of it (two syncs racing, a failed write) is back within the hour.
async function rebuildIndex(env, nowMs) {
  const devices = {};
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'dev:', cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const { name } of page.keys) {
      const dev = await env.KV.get(name, 'json');
      const next = nextUnsent(dev, nowMs);
      if (next) devices[name] = next;
    }
  } while (cursor);
  const idx = { rebuilt: new Date(nowMs).toISOString(), devices };
  await env.KV.put(INDEX_KEY, JSON.stringify(idx));
  return idx;
}

function deviceStatus(dev) {
  const now = Date.now();
  const upcoming = (dev.reminders || []).filter((r) => Date.parse(r.at) >= now - 30 * 60000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let host = null;
  try { host = dev.subscription ? new URL(dev.subscription.endpoint).host : null; } catch { host = null; }
  return {
    subscribed: Boolean(dev.subscription),
    pushService: host,
    scheduled: upcoming.length,
    next: upcoming[0] ? { title: upcoming[0].title, at: upcoming[0].at } : null,
    lastDelivery: dev.lastDelivery || null,
    lastTest: dev.lastTest || null,
    updatedAt: dev.updatedAt || null,
  };
}

async function handleDevice(request, env, token, sub, ctx) {
  if (!TOKEN_RE.test(token)) return json(env, { error: 'bad token' }, 400);
  const key = deviceKey(token);
  if (request.method === 'DELETE') {
    await env.KV.delete(key);
    await updateIndex(env, key, null);
    return json(env, { ok: true });
  }
  const existing = (await env.KV.get(key, 'json')) || { reminders: [], sent: {} };
  if (request.method === 'GET') return json(env, deviceStatus(existing));
  if (sub === 'test') {
    if (!existing.subscription) return json(env, { ok: false, error: 'This phone is not subscribed for reminders yet.' }, 400);
    const keys = await vapid(env);
    const res = await sendPush(existing.subscription, { title: 'Cadence', body: 'Reminders are working on this phone.', id: 'test' }, { subject: env.VAPID_SUBJECT || 'mailto:owner@example.com', keys });
    existing.lastTest = { at: new Date().toISOString(), status: res.status, ok: res.ok };
    if (res.gone) delete existing.subscription;
    await env.KV.put(key, JSON.stringify(existing), { expirationTtl: 400 * 86400 });
    return json(env, { ok: res.ok, status: res.status, gone: res.gone });
  }
  const body = await readJson(request);
  if (!body) return json(env, { error: 'json body required' }, 400);

  const s = body.subscription;
  if (s !== undefined || sub !== 'reminders') {
    if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') {
      return json(env, { error: 'subscription required' }, 400);
    }
    if (!/^https:\/\//.test(s.endpoint)) return json(env, { error: 'bad endpoint' }, 400);
    existing.subscription = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
    existing.tz = typeof body.tz === 'string' ? body.tz.slice(0, 64) : existing.tz;
  }
  // The app sends its subscription together with its reminders in one request, so
  // opening the app costs one write, not two.
  if (sub === 'reminders') {
    const reminders = (Array.isArray(body.reminders) ? body.reminders : []).slice(0, 500).map((r) => ({
      id: String(r.id || '').slice(0, 64),
      title: String(r.title || '').slice(0, 140),
      body: String(r.body || '').slice(0, 140),
      at: typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : null,
    })).filter((r) => r.id && r.title && r.at);
    existing.reminders = reminders;
    // Drop sent-markers for reminders that no longer exist or moved.
    const live = new Set(reminders.map((r) => `${r.id}@${r.at}`));
    existing.sent = Object.fromEntries(Object.entries(existing.sent || {}).filter(([k]) => live.has(k)));
  }
  existing.updatedAt = new Date().toISOString();
  await env.KV.put(key, JSON.stringify(existing), { expirationTtl: 400 * 86400 });
  await updateIndex(env, key, existing);
  // Anything due in the next two minutes is handled right now by this request, so a
  // "remind me in 30 seconds" never waits for the scheduler.
  if (sub === 'reminders' && existing.subscription && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(deliverDue(env, new Date(), { lookAheadMs: 120000, onlyKey: key }).catch(() => {}));
  }
  return json(env, { ok: true, reminders: (existing.reminders || []).length, subscribed: Boolean(existing.subscription) });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends the reminders that are due. The cron fires once a minute and can itself
// run late, so each run also CLAIMS reminders coming up in the next 90 seconds
// and then waits until their exact second before pushing. That turns "some time
// in the next minute or two" into "on the second".
//
// Claiming (writing the sent marker before the wait) is what keeps the next
// minute's run from sending the same reminder twice; the notification tag on the
// phone collapses any duplicate that a stale read still lets through.
async function deliverDue(env, now = new Date(), { lookAheadMs = 90000, wait = sleep, onlyKey = null } = {}) {
  const subject = env.VAPID_SUBJECT || 'mailto:owner@example.com';
  const start = now.getTime();
  const windowStart = start - LATE_LIMIT_MS;
  const horizon = start + lookAheadMs;

  // Which phones to open: the one that just synced, or whatever the index says is
  // due. Most minutes the index says nothing, and that costs a single read.
  let names;
  if (onlyKey) {
    names = [onlyKey];
  } else {
    let idx = await readIndex(env);
    if (!idx.rebuilt || start - Date.parse(idx.rebuilt) >= REBUILD_MS) idx = await rebuildIndex(env, start);
    names = Object.entries(idx.devices).filter(([, at]) => Date.parse(at) <= horizon).map(([name]) => name);
  }
  if (!names.length) return 0;
  const keys = await vapid(env);

  // Pass one: find everything due or coming up, and claim it.
  const pending = [];
  const touched = new Map();
  for (const name of names) {
    const dev = await env.KV.get(name, 'json');
    if (!dev || !dev.subscription || !Array.isArray(dev.reminders) || !dev.reminders.length) continue;
    const due = dev.reminders.filter((r) => {
      const t = Date.parse(r.at);
      return t <= horizon && t > windowStart && !(dev.sent && dev.sent[`${r.id}@${r.at}`]);
    });
    if (!due.length) continue;
    dev.sent = dev.sent || {};
    for (const r of due) {
      dev.sent[`${r.id}@${r.at}`] = new Date().toISOString();
      pending.push({ name, dev, reminder: r, at: Date.parse(r.at) });
    }
    touched.set(name, dev);
    await env.KV.put(name, JSON.stringify(dev), { expirationTtl: 400 * 86400 });
  }
  if (!pending.length) return 0;

  // Pass two: push each one at its own moment, earliest first.
  pending.sort((a, b) => a.at - b.at);
  let sentCount = 0;
  for (const item of pending) {
    const delay = item.at - Date.now();
    if (delay > 0) await wait(delay);
    const dev = item.dev;
    if (!dev.subscription) continue;
    const r = item.reminder;
    const res = await sendPush(dev.subscription, { title: r.title, body: r.body, id: r.id }, { subject, keys });
    dev.lastDelivery = { at: new Date().toISOString(), title: r.title, status: res.status, ok: res.ok };
    if (res.gone) delete dev.subscription;
    if (res.ok) sentCount += 1;
  }

  // Record what happened. The claim above already persisted; this saves the outcome
  // and moves each phone's index entry on to its next reminder.
  for (const [name, dev] of touched) {
    await env.KV.put(name, JSON.stringify(dev), { expirationTtl: 400 * 86400 });
    await updateIndex(env, name, dev);
  }
  return sentCount;
}

export { deliverDue };

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (path === '/api/health' && request.method === 'GET') {
        return json(env, { ok: true, claude: Boolean(env.ANTHROPIC_API_KEY), version: '1.1.0' });
      }
      if (path === '/api/vapid' && request.method === 'GET') {
        const keys = await vapid(env);
        return json(env, { publicKey: keys.publicKey });
      }
      if (path === '/api/parse' && request.method === 'POST') return handleParse(request, env);
      const m = path.match(/^\/api\/devices\/([^/]+)(?:\/(reminders|test))?$/);
      if (m && ['GET', 'PUT', 'POST', 'DELETE'].includes(request.method)) return handleDevice(request, env, m[1], m[2], ctx);
      if (path === '/api/deliver' && request.method === 'POST' && url.searchParams.get('key') && url.searchParams.get('key') === env.ADMIN_KEY) {
        return json(env, { sent: await deliverDue(env) });
      }
      return json(env, { error: 'not found' }, 404);
    } catch (e) {
      return json(env, { error: 'internal error', detail: String(e && e.message) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Use the real clock, not event.scheduledTime: when the scheduler itself runs
    // late, the look-ahead should still start from now.
    ctx.waitUntil(deliverDue(env));
  },
};

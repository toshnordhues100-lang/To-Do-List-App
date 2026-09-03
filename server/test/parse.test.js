import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserMessage, extractJson, normalize, parseUtterance, MODEL } from '../src/parse.js';

test('user message renders the caller local time and open tasks', () => {
  const msg = buildUserMessage({ text: 'wash the car tmr at 8', nowIso: '2026-09-03T03:41:00Z', tz: 'America/Chicago', tasks: [{ id: 'a1', title: 'Buy milk', due: '2026-09-03', time: null }] });
  assert.match(msg, /Wednesday 2026-09-02 22:41 \(time zone America\/Chicago\)/);
  assert.match(msg, /Tomorrow is 2026-09-03/);
  assert.match(msg, /a1 \| Buy milk \| 2026-09-03/);
  assert.match(msg, /User said: "wash the car tmr at 8"/);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Sure:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Here you go {"a":3} done'), { a: 3 });
  assert.equal(extractJson('nothing'), null);
});

test('normalize validates shapes and ids', () => {
  const tasks = [{ id: 'x1', title: 'Gym' }];
  const out = normalize({ actions: [
    { type: 'add', tasks: [{ title: 'Wash the car', due: '2026-09-04', time: '20:00', priority: 'urgent', tags: ['#home'], repeat: 'weekly' }, { title: '' }] },
    { type: 'complete', id: 'x1' }, { type: 'complete', id: 'nope' }, { type: 'bogus' },
    { type: 'reschedule', id: 'x1', due: 'friday', time: '9:00' },
  ], say: 'Done.' }, tasks);
  assert.equal(out.actions.length, 3);
  assert.deepEqual(out.actions[0].tasks[0], { title: 'Wash the car', due: '2026-09-04', time: '20:00', priority: 'normal', tags: ['home'], repeat: 'weekly', durationMin: null, notes: '' });
  assert.deepEqual(out.actions[1], { type: 'complete', id: 'x1' });
  assert.deepEqual(out.actions[2], { type: 'reschedule', id: 'x1', due: null, time: null });
  assert.equal(out.say, 'Done.');
});

test('parseUtterance calls the cheapest model and parses its reply', async () => {
  let seen = null;
  const client = { messages: { create: async (params) => { seen = params; return { content: [{ type: 'text', text: '{"actions":[{"type":"add","tasks":[{"title":"Wash the car","due":"2026-09-04","time":"20:00"}]}],"say":"Added wash the car, tomorrow at 8 PM."}' }], usage: { input_tokens: 600, output_tokens: 60 } }; } } };
  const r = await parseUtterance({ text: 'add wash the car at 8pm tmr night and remind me at 8', nowIso: '2026-09-03T03:41:00Z', tz: 'America/Chicago', tasks: [] }, client);
  assert.equal(seen.model, MODEL);
  assert.equal(MODEL, 'claude-haiku-4-5');
  assert.ok(seen.max_tokens <= 1000);
  assert.equal(r.ok, true);
  assert.equal(r.actions[0].tasks[0].time, '20:00');
  assert.equal(r.say, 'Added wash the car, tomorrow at 8 PM.');
});

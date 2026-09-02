import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, parseTask, findBestMatch, scoreMatch } from '../js/parser.js';

// Fixed reference point: Wednesday 2 September 2026, 10:30 local time.
const NOW = new Date(2026, 8, 2, 10, 30);

const add = (text) => {
  const r = parseInput(text, NOW);
  assert.equal(r.type, 'add', `expected add for "${text}" got ${r.type}`);
  return r.tasks[0];
};

test('plain task', () => {
  const t = add('buy milk');
  assert.equal(t.title, 'Buy milk');
  assert.equal(t.due, null);
  assert.equal(t.time, null);
  assert.equal(t.priority, 'normal');
});

test('lead-ins are stripped', () => {
  assert.equal(add('remind me to call mom').title, 'Call mom');
  assert.equal(add('add a task to water the plants').title, 'Water the plants');
  assert.equal(add("don't forget to submit the report").title, 'Submit the report');
  assert.equal(add('okay add pick up dry cleaning').title, 'Pick up dry cleaning');
  assert.equal(add('I need to renew my passport').title, 'Renew my passport');
});

test('tomorrow with pm time', () => {
  const t = add('call the dentist tomorrow at 3pm');
  assert.equal(t.title, 'Call the dentist');
  assert.equal(t.due, '2026-09-03');
  assert.equal(t.time, '15:00');
});

test('time before date wording', () => {
  const t = add('at 9 am on friday team standup');
  assert.equal(t.title, 'Team standup');
  assert.equal(t.due, '2026-09-04');
  assert.equal(t.time, '09:00');
});

test('ambiguous hour heuristics and period words', () => {
  assert.equal(add('gym at 6').time, '18:00');
  assert.equal(add('breakfast at 8').time, '08:00');
  assert.equal(add('meeting at 3 in the afternoon').time, '15:00');
  assert.equal(add('walk at 7 in the morning').time, '07:00');
  assert.equal(add('lunch at noon tomorrow').time, '12:00');
  assert.equal(add('take out trash tonight').time, '19:00');
  assert.equal(add('take out trash tonight').due, '2026-09-02');
  assert.equal(add('call bob at half past 4').time, '16:30');
  assert.equal(add('call bob at quarter to 5 pm').time, '16:45');
  assert.equal(add('standup at 9:15').time, '09:15');
  assert.equal(add('review at 15:45').time, '15:45');
});

test('bare time today or tomorrow depending on now', () => {
  assert.equal(add('lunch at 12pm').due, '2026-09-02');
  assert.equal(add('coffee at 9am').due, '2026-09-03');
});

test('spoken number words', () => {
  assert.equal(add('call bob at three pm').time, '15:00');
  assert.equal(add('in two hours check the oven').due, '2026-09-02');
  assert.equal(add('in two hours check the oven').time, '12:30');
  assert.equal(add('in twenty minutes call back').time, '10:50');
  assert.equal(add('pay rent on the fifteenth').due, '2026-09-15');
  assert.equal(add('dentist on the twenty third of september').due, '2026-09-23');
});

test('weekday resolution', () => {
  assert.equal(add('gym on friday').due, '2026-09-04');
  assert.equal(add('gym on wednesday').due, '2026-09-02');
  assert.equal(add('gym next monday').due, '2026-09-07');
  assert.equal(add('gym next friday').due, '2026-09-11');
  assert.equal(add('gym next week').due, '2026-09-07');
  assert.equal(add('hike this weekend').due, '2026-09-05');
});

test('relative dates', () => {
  assert.equal(add('renew license in 3 days').due, '2026-09-05');
  assert.equal(add('renew license in a week').due, '2026-09-09');
  assert.equal(add('renew license in 2 months').due, '2026-11-02');
  assert.equal(add('day after tomorrow send invoice').due, '2026-09-04');
  assert.equal(add('pay bills end of month').due, '2026-09-30');
});

test('absolute dates', () => {
  assert.equal(add('conference on october 15').due, '2026-10-15');
  assert.equal(add('conference oct 15th').due, '2026-10-15');
  assert.equal(add('conference on the 15th of october').due, '2026-10-15');
  assert.equal(add('birthday on 1/20').due, '2027-01-20');
  assert.equal(add('conference on 2026-12-01').due, '2026-12-01');
  assert.equal(add('pay rent on the 1st').due, '2026-10-01');
});

test('priority', () => {
  assert.equal(add('urgent fix the login bug').priority, 'high');
  assert.equal(add('fix the login bug high priority').priority, 'high');
  assert.equal(add('fix the login bug high priority').title, 'Fix the login bug');
  assert.equal(add('organize photos low priority').priority, 'low');
  assert.equal(add('organize photos someday').priority, 'low');
});

test('tags', () => {
  assert.deepEqual(add('prepare slides #work').tags, ['work']);
  assert.deepEqual(add('prepare slides hashtag work').tags, ['work']);
  assert.deepEqual(add('prepare slides tag work').tags, ['work']);
  assert.equal(add('prepare slides tag work').title, 'Prepare slides');
});

test('recurrence', () => {
  const t = add('take vitamins every morning');
  assert.equal(t.repeat, 'daily');
  assert.equal(t.time, '09:00');
  assert.equal(t.due, '2026-09-03');
  const w = add('team meeting every monday at 10');
  assert.equal(w.repeat, 'weekly');
  assert.equal(w.due, '2026-09-07');
  assert.equal(w.time, '10:00');
  assert.equal(add('pay rent monthly').repeat, 'monthly');
  assert.equal(add('standup every weekday at 9:30').repeat, 'weekdays');
  assert.equal(add('standup every weekday at 9:30').title, 'Standup');
});

test('duration', () => {
  const t = add('deep work block tomorrow at 2pm for 2 hours');
  assert.equal(t.durationMin, 120);
  assert.equal(t.title, 'Deep work block');
  assert.equal(add('stretch for 15 minutes').durationMin, 15);
});

test('multiple tasks in one utterance', () => {
  const r = parseInput('buy milk and then call the bank and also book a haircut on saturday', NOW);
  assert.equal(r.type, 'add');
  assert.deepEqual(r.tasks.map((t) => t.title), ['Buy milk', 'Call the bank', 'Book a haircut']);
  assert.equal(r.tasks[2].due, '2026-09-05');
});

test('notes', () => {
  const t = add('call landlord note ask about the deposit');
  assert.equal(t.title, 'Call landlord');
  assert.equal(t.notes, 'ask about the deposit');
});

test('commands', () => {
  assert.deepEqual(parseInput('complete buy milk', NOW), { type: 'complete', query: 'buy milk' });
  assert.deepEqual(parseInput('check off the dentist task', NOW), { type: 'complete', query: 'dentist' });
  assert.deepEqual(parseInput('mark call mom as done', NOW), { type: 'complete', query: 'call mom' });
  assert.deepEqual(parseInput('buy milk is done', NOW), { type: 'complete', query: 'buy milk' });
  assert.deepEqual(parseInput('delete the gym task', NOW), { type: 'delete', query: 'gym' });
  assert.deepEqual(parseInput('remove buy milk', NOW), { type: 'delete', query: 'buy milk' });
  assert.deepEqual(parseInput('show calendar', NOW), { type: 'navigate', view: 'calendar' });
  assert.deepEqual(parseInput('open the list', NOW), { type: 'navigate', view: 'list' });
  assert.deepEqual(parseInput('go to insights', NOW), { type: 'navigate', view: 'insights' });
  assert.deepEqual(parseInput("what's on today", NOW), { type: 'read', scope: 'today' });
  assert.deepEqual(parseInput('what do i have tomorrow', NOW), { type: 'read', scope: 'tomorrow' });
  assert.deepEqual(parseInput('read my tasks for this week', NOW), { type: 'read', scope: 'week' });
  assert.deepEqual(parseInput('what is overdue', NOW), { type: 'read', scope: 'overdue' });
  assert.deepEqual(parseInput('undo', NOW), { type: 'undo' });
  assert.deepEqual(parseInput('clear completed tasks', NOW), { type: 'clearCompleted' });
  assert.deepEqual(parseInput('search groceries', NOW), { type: 'search', query: 'groceries' });
  assert.deepEqual(parseInput('switch to dark mode', NOW), { type: 'theme', theme: 'dark' });
  assert.deepEqual(parseInput('make dentist high priority', NOW), { type: 'setPriority', query: 'dentist', priority: 'high' });
  assert.deepEqual(parseInput('rename gym to morning run', NOW), { type: 'rename', query: 'gym', title: 'Morning run' });
});

test('reschedule command', () => {
  const r = parseInput('move gym to friday', NOW);
  assert.equal(r.type, 'reschedule');
  assert.equal(r.query, 'gym');
  assert.equal(r.due, '2026-09-04');
  const r2 = parseInput('postpone the dentist until next week at 2pm', NOW);
  assert.equal(r2.type, 'reschedule');
  assert.equal(r2.query, 'dentist');
  assert.equal(r2.due, '2026-09-07');
  assert.equal(r2.time, '14:00');
  const r3 = parseInput('push report by 2 days', NOW);
  assert.equal(r3.type, 'reschedule');
  assert.equal(r3.byDays, 2);
});

test('fuzzy matching', () => {
  const tasks = [
    { id: 1, title: 'Call the dentist' },
    { id: 2, title: 'Buy milk' },
    { id: 3, title: 'Prepare quarterly slides' },
  ];
  assert.equal(findBestMatch('dentist', tasks).task.id, 1);
  assert.equal(findBestMatch('the milk', tasks).task.id, 2);
  assert.equal(findBestMatch('quarterly slides', tasks).task.id, 3);
  assert.equal(findBestMatch('walk the dog', tasks), null);
  assert.ok(scoreMatch('buy milk', 'Buy milk') === 1);
});

test('parseTask keeps ordinary words intact', () => {
  assert.equal(parseTask('order two pizzas for the party', NOW).title, 'Order two pizzas for the party');
  assert.equal(parseTask('read the first chapter', NOW).title, 'Read the first chapter');
  assert.equal(parseTask('buy 3 apples', NOW).title, 'Buy 3 apples');
});

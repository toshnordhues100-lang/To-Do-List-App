import {
  WEEKDAYS, WEEKDAYS_SHORT, MONTHS, toISODate, fromISODate, addDays,
  formatTime, formatDate, formatLongDate, formatDuration, toTimeString,
} from './dates.js';
import { parseInput, parseTask, findBestMatch, relativeOffset } from './parser.js';
import {
  loadTasks, saveTasks, loadSettings, saveSettings, createTask, nextOccurrence,
  REPEAT_LABELS, exportData, importData, DEFAULT_SETTINGS,
} from './store.js';
import { VoiceInput, voiceSupported, speechSupported, speak, stopSpeaking } from './voice.js';

const APP_VERSION = '2.0.0';
const API = String((window.CADENCE_CONFIG && window.CADENCE_CONFIG.apiUrl) || '').replace(/\/+$/, '');
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const V2_DEFAULTS = {
  ...DEFAULT_SETTINGS,
  reminderLead: 0,
  smartParsing: true,
  remindByDefault: true,
  dailyReminderTime: '09:00',
  pushEnabled: false,
  remindPrompted: false,
};

const state = {
  tasks: loadTasks(),
  settings: { ...V2_DEFAULTS, ...loadSettings() },
  view: 'list',
  listFilter: 'all',
  search: '',
  selectedDate: toISODate(new Date()),
  calMonth: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  undo: [],
  redo: [],
  listening: false,
  thinking: false,
  completedOpen: false,
  pending: null,
  editingId: null,
  installPrompt: null,
  briefedOn: localStorage.getItem('cadence.briefedOn') || '',
  server: API ? 'unknown' : 'none',   // none | unknown | on | off
  serverStatus: null,
  lastTest: null,
  push: 'unknown',                    // unknown | on | off | unsupported | needs_install | denied
  syncTimer: null,
};

// ---------------------------------------------------------------- utilities

function now() { return new Date(); }
function todayISO() { return toISODate(now()); }
function nowTime() { const d = now(); return toTimeString(d.getHours(), d.getMinutes()); }

function isOverdue(task) {
  if (!task.due || task.completedAt) return false;
  if (task.due < todayISO()) return true;
  if (task.due === todayISO() && task.time && task.time < nowTime()) return true;
  return false;
}

const PRIO_RANK = { high: 0, normal: 1, low: 2 };

function sortTasks(a, b) {
  if ((a.due || '9999') !== (b.due || '9999')) return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
  if ((a.time || '99') !== (b.time || '99')) return (a.time || '99') < (b.time || '99') ? -1 : 1;
  if (PRIO_RANK[a.priority] !== PRIO_RANK[b.priority]) return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
  return a.order - b.order;
}

function openTasks() { return state.tasks.filter((t) => !t.completedAt); }
function completedTasks() { return state.tasks.filter((t) => t.completedAt); }

function matchesSearch(task, q) {
  if (!q) return true;
  const hay = `${task.title} ${task.notes} ${task.tags.map((t) => '#' + t).join(' ')} ${task.tags.join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function tasksForDate(iso) { return state.tasks.filter((t) => t.due === iso).sort(sortTasks); }

function describeTask(task, { withDate = true } = {}) {
  const parts = [];
  if (withDate && task.due) parts.push(formatDate(task.due, now()));
  if (task.time) parts.push(formatTime(task.time, state.settings.hour12));
  if (task.durationMin) parts.push(formatDuration(task.durationMin));
  if (task.repeat) parts.push(REPEAT_LABELS[task.repeat]);
  if (task.priority === 'high') parts.push('High priority');
  if (task.tags.length) parts.push(task.tags.map((t) => '#' + t).join(' '));
  return parts.join(' · ');
}

function spokenTask(task, { withDate = true } = {}) {
  const parts = [task.title];
  if (withDate && task.due) parts.push(formatDate(task.due, now()).toLowerCase());
  if (task.time) parts.push('at ' + formatTime(task.time, true));
  if (task.repeat) parts.push(REPEAT_LABELS[task.repeat].toLowerCase());
  return parts.join(', ');
}

function formatCountdown(ms) {
  if (ms <= 0) return ms > -60000 ? 'now' : '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return m ? `in ${h} h ${m} min` : `in ${h} h`; }
  return '';
}

function countdownSpan(at, cls = 'countdown') {
  const ms = at.getTime() - Date.now();
  if (ms > 86400000 || ms <= -60000) return '';
  return `<span class="${cls}" data-count-at="${at.getTime()}">${esc(formatCountdown(ms))}</span>`;
}

// Runs every second. Every value is recomputed from the real clock, so a phone
// that suspended the app for an hour shows the true remaining time on resume.
let crossedTimer = null;
function tickCountdowns() {
  const nowMs = Date.now();
  let crossed = false;
  document.querySelectorAll('[data-count-at]').forEach((node) => {
    const at = Number(node.dataset.countAt);
    const text = formatCountdown(at - nowMs);
    if (node.textContent !== text) node.textContent = text;
    if (at <= nowMs && !node.dataset.done) { node.dataset.done = '1'; crossed = true; }
  });
  if (crossed && !crossedTimer) crossedTimer = setTimeout(() => { crossedTimer = null; render(); }, 1500);
}

function nextReminder() {
  let best = null;
  for (const t of openTasks()) {
    const at = reminderMoment(t);
    if (!at || at.getTime() < Date.now() - 60000) continue;
    if (!best || at < best.at) best = { task: t, at };
  }
  return best;
}

function timeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function deviceToken() {
  let t = localStorage.getItem('cadence.device');
  if (!t || !/^[A-Za-z0-9_-]{16,128}$/.test(t)) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    t = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('cadence.device', t);
  }
  return t;
}

function reminderMoment(task) {
  // When this task should ring: an exact moment for "in 10 minutes" style tasks,
  // its own time, or the daily reminder time for date-only tasks.
  if (task.completedAt || task.remind === false) return null;
  if (task.remindAt) {
    const at = new Date(task.remindAt);
    if (!Number.isNaN(at.getTime())) return new Date(at.getTime() - (task.time ? state.settings.reminderLead : 0) * 60000);
  }
  if (!task.due) return null;
  const time = task.time || state.settings.dailyReminderTime || '09:00';
  const [h, m] = time.split(':').map(Number);
  const at = fromISODate(task.due);
  at.setHours(h, m - (task.time ? state.settings.reminderLead : 0), 0, 0);
  return at;
}

// ---------------------------------------------------------------- persistence + undo

function afterChange() {
  saveTasks(state.tasks);
  scheduleReminderSync();
}

function commit(mutator) {
  state.undo.push(JSON.stringify(state.tasks));
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  const result = mutator();
  afterChange();
  render();
  return result;
}

function undo() {
  if (!state.undo.length) { toast('Nothing to undo'); return false; }
  state.redo.push(JSON.stringify(state.tasks));
  state.tasks = JSON.parse(state.undo.pop());
  afterChange();
  render();
  toast('Undone');
  return true;
}

function redo() {
  if (!state.redo.length) { toast('Nothing to redo'); return false; }
  state.undo.push(JSON.stringify(state.tasks));
  state.tasks = JSON.parse(state.redo.pop());
  afterChange();
  render();
  toast('Redone');
  return true;
}

function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  applyTheme();
  voice.setLanguage(state.settings.language);
  if ('reminderLead' in patch || 'dailyReminderTime' in patch) scheduleReminderSync();
  render();
}

// ---------------------------------------------------------------- task operations

function addTasks(parsedTasks, source = 'text') {
  const created = parsedTasks.map((p) => {
    const fields = { ...p, source };
    if (fields.remind === undefined) fields.remind = state.settings.remindByDefault;
    if (!fields.due && state.view === 'calendar' && state.selectedDate !== todayISO()) fields.due = state.selectedDate;
    return createTask(fields);
  });
  commit(() => { state.tasks.push(...created); });
  maybePromptReminders(created);
  return created;
}

function completeTask(task) {
  commit(() => {
    const t = state.tasks.find((x) => x.id === task.id);
    if (!t) return;
    t.completedAt = new Date().toISOString();
    if (t.repeat) {
      const due = nextOccurrence(t, now());
      if (due) state.tasks.push(createTask({ ...t, due, completedAt: null, notifiedAt: null, remindAt: null }));
    }
  });
}

function reopenTask(task) {
  commit(() => { const t = state.tasks.find((x) => x.id === task.id); if (t) t.completedAt = null; });
}

function deleteTask(task) {
  commit(() => { state.tasks = state.tasks.filter((x) => x.id !== task.id); });
}

function patchTask(task, patch) {
  commit(() => {
    const t = state.tasks.find((x) => x.id === task.id);
    if (!t) return;
    const timing = ('due' in patch && patch.due !== t.due) || ('time' in patch && patch.time !== t.time);
    Object.assign(t, patch, { notifiedAt: timing ? null : t.notifiedAt, remindAt: timing ? null : t.remindAt });
  });
}

function findTask(query, { includeCompleted = false } = {}) {
  const pool = includeCompleted ? state.tasks : openTasks();
  return findBestMatch(query, pool);
}

// ---------------------------------------------------------------- feedback

let toastTimer = null;
function toast(text, { action, onAction, duration = 4500 } = {}) {
  const box = el('toast');
  el('toastText').textContent = text;
  const btn = el('toastAction');
  if (action) {
    btn.textContent = action;
    btn.hidden = false;
    btn.onclick = () => { box.hidden = true; if (onAction) onAction(); };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, duration);
}

function say(text) {
  if (!state.settings.voiceFeedback || !speechSupported || !text) return;
  const wasListening = state.listening;
  if (wasListening) voice.pause();
  speak(text, { lang: state.settings.language, onEnd: () => { if (wasListening) voice.resume(); } });
}

function showResult(html) {
  const box = el('captureResult');
  box.innerHTML = html;
  box.hidden = false;
}

function resultCard(label, task) {
  const at = reminderMoment(task);
  const note = at && state.settings.pushEnabled ? ' · Reminder ' + (countdownSpan(at, 'countdown inline') || 'set') : '';
  return `<div class="result-card"><span class="result-label">${esc(label)}</span><div><div class="result-title">${esc(task.title)}</div><div class="result-meta">${esc(describeTask(task)) || 'No date'}${note}</div></div></div>`;
}

let confirmResolve = null;
function confirmAction({ title = 'Are you sure?', message = '', okLabel = 'Delete', danger = true } = {}) {
  el('confirmTitle').textContent = title;
  el('confirmText').textContent = message;
  const ok = el('confirmOk');
  ok.textContent = okLabel;
  ok.className = danger ? 'btn danger' : 'btn primary';
  el('confirmSheet').hidden = false;
  el('backdrop').hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  el('confirmSheet').hidden = true;
  if (!anySheetOpen()) el('backdrop').hidden = true;
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

// ---------------------------------------------------------------- Claude understanding (through the Cadence API)

async function smartParse(text) {
  if (!API || !state.settings.smartParsing || state.server === 'off') return null;
  try {
    const res = await fetch(`${API}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        now: new Date().toISOString(),
        tz: timeZoneName(),
        token: deviceToken(),
        tasks: openTasks().sort(sortTasks).slice(0, 120).map((t) => ({ id: t.id, title: t.title, due: t.due, time: t.time })),
      }),
    });
    if (res.status === 429) { toast('Claude is busy right now. Using the built-in understanding for this one.', { duration: 5000 }); return null; }
    if (res.status === 503) { state.server = 'off'; return null; }
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.actions) || data.ok === false) return null;
    state.server = 'on';
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    const actions = data.actions.map((a) => (a.id ? { ...a, task: byId.get(String(a.id)) || null } : a)).filter((a) => !a.id || a.task);
    return { actions, say: typeof data.say === 'string' ? data.say : '' };
  } catch {
    return null;
  }
}

async function probeServer() {
  if (!API) return;
  try {
    const res = await fetch(`${API}/api/health`, { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    state.server = data && data.ok && data.claude ? 'on' : 'off';
  } catch {
    state.server = 'off';
  }
  if (state.view === 'settings') render();
}

// ---------------------------------------------------------------- command handling

const LOCAL_ONLY = new Set(['navigate', 'undo', 'redo', 'stop', 'theme', 'search']);

async function handleInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  const local = parseInput(text, now());
  if (LOCAL_ONLY.has(local.type)) { await applyCommand(local); return; }

  let cmds = null;
  let sayText = '';
  const relative = relativeOffset(text, now());
  if (API && state.settings.smartParsing && state.server !== 'off') {
    setThinking(true);
    const smart = await smartParse(text);
    setThinking(false);
    if (smart && smart.actions.length) { cmds = smart.actions; sayText = smart.say; }
    else if (smart) { cmds = [{ type: 'none', reason: smart.say || 'Nothing to do' }]; sayText = smart.say; }
  }
  if (!cmds) cmds = [local];

  // "In 90 seconds" style requests keep their exact moment instead of a rounded clock time.
  if (relative) {
    for (const cmd of cmds) {
      if (cmd.type !== 'add') continue;
      for (const t of cmd.tasks) {
        t.remindAt = relative.at.toISOString();
        t.due = toISODate(relative.at);
        t.time = toTimeString(relative.at.getHours(), relative.at.getMinutes());
      }
    }
  }

  const replies = [];
  for (const cmd of cmds) {
    const r = await applyCommand(cmd);
    if (r) replies.push(r);
  }
  const spoken = sayText || replies.join('. ');
  if (spoken) say(spoken);
}

function setThinking(on) {
  state.thinking = on;
  el('captureDot').classList.toggle('thinking', on);
  if (on) {
    el('captureStatus').textContent = 'Understanding';
    el('transcript').classList.add('thinking');
  } else {
    el('transcript').classList.remove('thinking');
    renderMicState('Ready');
  }
}

async function applyCommand(cmd) {
  const resolveTask = (c, { includeCompleted = false } = {}) => {
    if (c.task) return state.tasks.find((t) => t.id === c.task.id) || null;
    if (c.query) { const m = findTask(c.query, { includeCompleted }); return m ? m.task : null; }
    return null;
  };
  const notFound = (q) => { showResult(`<p class="muted">No task matches "${esc(q || 'that')}".</p>`); return `I couldn't find a task matching ${q || 'that'}`; };

  switch (cmd.type) {
    case 'noop':
    case 'none':
      showResult(`<p class="muted">${esc(cmd.reason || 'Nothing to add from that.')}</p>`);
      return cmd.reason || '';

    case 'add': {
      if (state.settings.confirmBeforeAdd) {
        state.pending = cmd.tasks;
        renderPending();
        return cmd.tasks.length === 1 ? `Ready to save ${cmd.tasks[0].title}. Confirm?` : `Ready to save ${cmd.tasks.length} tasks.`;
      }
      const created = addTasks(cmd.tasks, 'voice');
      showResult(created.map((t) => resultCard('Added', t)).join(''));
      toast(created.length === 1 ? `Added "${created[0].title}"` : `Added ${created.length} tasks`, { action: 'Undo', onAction: undo });
      if (created.length === 1 && created[0].remindAt) {
        const secs = Math.round((new Date(created[0].remindAt) - Date.now()) / 1000);
        const spokenIn = secs < 90 ? `${secs} seconds` : secs < 5400 ? `${Math.round(secs / 60)} minutes` : `${(secs / 3600).toFixed(1).replace(/\.0$/, '')} hours`;
        return `Added ${created[0].title}. I will remind you in ${spokenIn}`;
      }
      return created.length === 1 ? `Added ${spokenTask(created[0])}` : `Added ${created.length} tasks`;
    }

    case 'complete': {
      const t = resolveTask(cmd);
      if (!t) return notFound(cmd.query);
      completeTask(t);
      showResult(resultCard('Completed', t));
      toast(`Completed "${t.title}"`, { action: 'Undo', onAction: undo });
      return `Completed ${t.title}`;
    }

    case 'completeAll': {
      const due = openTasks().filter((t) => t.due && t.due <= todayISO());
      if (!due.length) return 'Nothing due today';
      commit(() => { due.forEach((t) => { const x = state.tasks.find((y) => y.id === t.id); if (x) x.completedAt = new Date().toISOString(); }); });
      toast(`Completed ${due.length} tasks`, { action: 'Undo', onAction: undo });
      return `Completed ${due.length} tasks due today`;
    }

    case 'reopen': {
      const t = cmd.task ? state.tasks.find((x) => x.id === cmd.task.id) : (findBestMatch(cmd.query || '', completedTasks()) || {}).task;
      if (!t) return `No completed task matches ${cmd.query || 'that'}`;
      reopenTask(t);
      toast(`Reopened "${t.title}"`, { action: 'Undo', onAction: undo });
      return `Reopened ${t.title}`;
    }

    case 'delete': {
      const t = resolveTask(cmd, { includeCompleted: true });
      if (!t) return notFound(cmd.query);
      deleteTask(t);
      showResult(resultCard('Deleted', t));
      toast(`Deleted "${t.title}"`, { action: 'Undo', onAction: undo });
      return `Deleted ${t.title}`;
    }

    case 'deleteAll': {
      if (!state.tasks.length) return 'There is nothing to delete';
      const ok = await confirmAction({ title: 'Delete every task?', message: `This removes all ${state.tasks.length} tasks permanently. You can undo right after.`, okLabel: 'Delete all' });
      if (!ok) return 'Cancelled';
      commit(() => { state.tasks = []; });
      toast('Deleted all tasks', { action: 'Undo', onAction: undo, duration: 8000 });
      return 'Deleted everything';
    }

    case 'reschedule': {
      const t = resolveTask(cmd);
      if (!t) return notFound(cmd.query);
      const patch = {};
      if (cmd.byDays) patch.due = toISODate(addDays(fromISODate(t.due) || now(), cmd.byDays));
      if (cmd.due) patch.due = cmd.due;
      if (cmd.time) { patch.time = cmd.time; if (!patch.due && !t.due) patch.due = todayISO(); }
      patchTask(t, patch);
      const updated = state.tasks.find((x) => x.id === t.id);
      showResult(resultCard('Rescheduled', updated));
      toast(`Moved "${updated.title}" to ${formatDate(updated.due, now())}`, { action: 'Undo', onAction: undo });
      return `Moved ${spokenTask(updated)}`;
    }

    case 'setPriority': {
      const t = resolveTask(cmd);
      if (!t) return notFound(cmd.query);
      patchTask(t, { priority: cmd.priority });
      toast(`${t.title}: ${cmd.priority} priority`, { action: 'Undo', onAction: undo });
      return `${t.title} is now ${cmd.priority} priority`;
    }

    case 'rename': {
      const t = resolveTask(cmd);
      if (!t) return notFound(cmd.query);
      patchTask(t, { title: cmd.title });
      toast(`Renamed to "${cmd.title}"`, { action: 'Undo', onAction: undo });
      return `Renamed to ${cmd.title}`;
    }

    case 'clearCompleted': {
      const n = completedTasks().length;
      if (!n) return 'No completed tasks to clear';
      const ok = await confirmAction({ title: 'Clear completed tasks?', message: `${n} completed ${n === 1 ? 'task' : 'tasks'} will be removed permanently.`, okLabel: 'Clear' });
      if (!ok) return 'Cancelled';
      commit(() => { state.tasks = openTasks(); });
      toast(`Cleared ${n} completed`, { action: 'Undo', onAction: undo });
      return `Cleared ${n} completed tasks`;
    }

    case 'navigate': {
      if (cmd.view === 'today' || cmd.view === 'tomorrow') {
        state.selectedDate = toISODate(addDays(now(), cmd.view === 'today' ? 0 : 1));
        const d = fromISODate(state.selectedDate);
        state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        setView('calendar');
      } else if (cmd.view === 'overdue') { state.listFilter = 'overdue'; setView('list'); }
      else if (cmd.view === 'completed') { state.completedOpen = true; state.listFilter = 'all'; setView('list'); }
      else setView(cmd.view);
      closeCapture();
      return '';
    }

    case 'theme':
      updateSettings({ theme: cmd.theme });
      toast(`${cap(cmd.theme)} theme`);
      return '';

    case 'read': {
      const { text: readText, html } = readBack(cmd);
      showResult(html);
      return readText;
    }

    case 'search':
      state.search = cmd.query;
      el('searchInput').value = cmd.query;
      el('searchBar').hidden = !cmd.query;
      setView('list');
      closeCapture();
      return '';

    case 'undo': undo(); return 'Undone';
    case 'redo': redo(); return '';
    case 'stop': stopListening(); closeCapture(); return '';
    default: return '';
  }
}

function readBack(cmd) {
  const t = todayISO();
  let list = [];
  let label = '';
  if (cmd.scope === 'today') { list = openTasks().filter((x) => x.due && x.due <= t); label = 'today'; }
  else if (cmd.scope === 'tomorrow') { const d = toISODate(addDays(now(), 1)); list = openTasks().filter((x) => x.due === d); label = 'tomorrow'; }
  else if (cmd.scope === 'week') { const end = toISODate(addDays(now(), 6)); list = openTasks().filter((x) => x.due && x.due <= end); label = 'this week'; }
  else if (cmd.scope === 'nextweek') { const s = toISODate(addDays(now(), 7)); const e = toISODate(addDays(now(), 13)); list = openTasks().filter((x) => x.due && x.due >= s && x.due <= e); label = 'next week'; }
  else if (cmd.scope === 'overdue') { list = openTasks().filter(isOverdue); label = 'overdue'; }
  else if (cmd.scope === 'date' && cmd.date) { list = openTasks().filter((x) => x.due === cmd.date); label = 'on ' + formatDate(cmd.date, now()); }
  else { list = openTasks(); label = 'in total'; }
  list = list.slice().sort(sortTasks);
  const withDate = !['today', 'tomorrow', 'date'].includes(cmd.scope);
  let text;
  if (!list.length) text = `Nothing ${label === 'in total' ? 'open' : label}.`;
  else {
    const head = list.slice(0, 8).map((x) => spokenTask(x, { withDate }));
    const more = list.length > 8 ? `, and ${list.length - 8} more` : '';
    text = `${list.length === 1 ? 'One task' : list.length + ' tasks'} ${label}: ${head.join('; ')}${more}.`;
  }
  const html = `<p class="result-heading">${esc(cap(label === 'in total' ? 'Everything open' : label))}</p>` +
    (list.length ? `<ul class="result-list">${list.map((x) => `<li><span>${esc(x.title)}</span><span class="muted">${esc(describeTask(x, { withDate }))}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing here.</p>');
  return { text, html };
}

function renderPending() {
  if (!state.pending) return;
  showResult(`
    <p class="result-heading">Review before saving</p>
    ${state.pending.map((t, i) => `<div class="result-card"><span class="result-label">${i + 1}</span><div><div class="result-title">${esc(t.title)}</div><div class="result-meta">${esc(describeTask({ ...t, tags: t.tags || [] })) || 'No date'}</div></div></div>`).join('')}
    <div class="pending-actions">
      <button class="btn primary" data-pending="save">Save</button>
      <button class="btn secondary" data-pending="edit">Edit</button>
      <button class="btn text" data-pending="discard">Discard</button>
    </div>`);
}

// ---------------------------------------------------------------- reminders (push through the Cadence API)

function pushSupport() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!API) return 'no_server';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS && !standalone ? 'needs_install' : 'unsupported';
  }
  if (isIOS && !standalone) return 'needs_install';
  return 'ok';
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enableReminders({ silent = false } = {}) {
  const support = pushSupport();
  if (support !== 'ok') {
    state.push = support === 'needs_install' ? 'needs_install' : 'unsupported';
    if (!silent) {
      if (support === 'needs_install') openRemindSheet({ steps: true });
      else toast('This browser cannot show reminders when the app is closed. Chrome on Android or an installed app on iPhone can.', { duration: 8000 });
    }
    render();
    return false;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      state.push = 'denied';
      if (!silent) toast('Reminders stay off until notifications are allowed for Cadence in your phone settings.', { duration: 8000 });
      render();
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    const keyRes = await fetch(`${API}/api/vapid`);
    const { publicKey } = await keyRes.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const res = await fetch(`${API}/api/devices/${deviceToken()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), tz: timeZoneName() }),
    });
    if (!res.ok) throw new Error('register failed');
    state.push = 'on';
    updateSettings({ pushEnabled: true, remindPrompted: true });
    await syncReminders();
    if (!silent) toast('Reminders are on. Sending a test notification now.', { duration: 6000 });
    testReminder({ quiet: true });
    return true;
  } catch (e) {
    state.push = 'off';
    if (!silent) toast('Could not turn on reminders. Check your connection and try again.', { duration: 7000 });
    render();
    return false;
  }
}

async function disableReminders() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    await fetch(`${API}/api/devices/${deviceToken()}`, { method: 'DELETE' });
  } catch { /* ignore */ }
  state.push = 'off';
  updateSettings({ pushEnabled: false });
  toast('Reminders are off');
}

function scheduleReminderSync() {
  if (!API || !state.settings.pushEnabled) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => { syncReminders(); }, 400);
}

async function syncReminders() {
  if (!API || !state.settings.pushEnabled) return;
  const horizon = now().getTime() - 30 * 60000;
  const reminders = openTasks().map((t) => {
    const at = reminderMoment(t);
    if (!at || at.getTime() < horizon) return null;
    const when = t.time ? formatTime(t.time, state.settings.hour12) : formatDate(t.due, now());
    return { id: t.id, title: t.title, body: t.time ? `${formatDate(t.due, now())} · ${when}` : `Due ${when.toLowerCase()}`, at: at.toISOString() };
  }).filter(Boolean);
  try {
    const res = await fetch(`${API}/api/devices/${deviceToken()}/reminders`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminders }),
    });
    if (res.ok) { const d = await res.json(); if (d && d.subscribed === false) state.push = 'off'; }
  } catch { /* offline: next change retries */ }
}

// Ask the server to push a real notification to this phone right now.
async function testReminder({ quiet = false } = {}) {
  if (!API) return;
  try {
    const res = await fetch(`${API}/api/devices/${deviceToken()}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    state.lastTest = { at: new Date(), status: data.status, ok: data.ok, error: data.error };
    if (data.ok) { if (!quiet) toast(`Test sent. Apple or Google answered ${data.status}. It should appear on your phone within a few seconds.`, { duration: 8000 }); }
    else if (data.gone) { state.push = 'off'; updateSettings({ pushEnabled: false }); toast('This phone\'s subscription expired. Turn reminders on again.', { duration: 8000 }); }
    else toast(data.error ? data.error : `The push service refused the message (status ${data.status}).`, { duration: 8000 });
  } catch {
    state.lastTest = { at: new Date(), error: 'Could not reach the server' };
    toast('Could not reach the reminder server.', { duration: 6000 });
  }
  refreshServerStatus();
}

async function refreshServerStatus() {
  if (!API) return;
  try {
    const res = await fetch(`${API}/api/devices/${deviceToken()}`, { cache: 'no-store' });
    state.serverStatus = res.ok ? await res.json() : null;
  } catch { state.serverStatus = null; }
  if (state.view === 'settings') render();
}

async function restorePushState() {
  if (!API) { state.push = 'unsupported'; return; }
  const support = pushSupport();
  if (support !== 'ok') { state.push = support === 'needs_install' ? 'needs_install' : 'unsupported'; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      state.push = 'on';
      if (!state.settings.pushEnabled) updateSettings({ pushEnabled: true });
      // Re-register in case the server forgot us; cheap.
      fetch(`${API}/api/devices/${deviceToken()}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), tz: timeZoneName() }) }).then(() => syncReminders()).catch(() => {});
    } else {
      state.push = Notification.permission === 'denied' ? 'denied' : 'off';
      if (state.settings.pushEnabled) updateSettings({ pushEnabled: false });
    }
  } catch {
    state.push = 'off';
  }
  if (state.view === 'settings') render();
}

function maybePromptReminders(created) {
  if (!API || state.settings.pushEnabled || state.settings.remindPrompted) return;
  if (!created.some((t) => reminderMoment(t))) return;
  if (['unsupported'].includes(state.push)) return;
  setTimeout(() => openRemindSheet({ steps: pushSupport() === 'needs_install' }), 600);
}

function openRemindSheet({ steps = false } = {}) {
  if (!el('captureSheet').hidden) closeCapture();
  el('remindSteps').hidden = !steps;
  el('remindOn').hidden = steps;
  el('remindText').textContent = steps
    ? 'On iPhone, reminders work once Cadence is on your home screen. It takes three taps:'
    : 'Cadence can notify you when a task is due, even when the app is closed and your phone is locked. Every task with a date gets a reminder unless you switch it off for that task.';
  el('remindSheet').hidden = false;
  el('backdrop').hidden = false;
}

function closeRemindSheet() {
  el('remindSheet').hidden = true;
  if (!anySheetOpen()) el('backdrop').hidden = true;
}

// In-app reminders for phones without push: a toast and a spoken line while the app is open.
function checkRemindersLocally() {
  if (state.settings.pushEnabled) return;
  const n = now();
  let changed = false;
  for (const task of openTasks()) {
    if (task.notifiedAt) continue;
    const at = reminderMoment(task);
    if (!at) continue;
    const diffMin = (at - n) / 60000;
    if (diffMin <= 0 && diffMin > -30) {
      toast(`Reminder: ${task.title}${task.time ? ' · ' + formatTime(task.time, state.settings.hour12) : ''}`, { duration: 15000 });
      say(`Reminder: ${task.title}`);
      task.notifiedAt = n.toISOString();
      changed = true;
    }
  }
  if (changed) saveTasks(state.tasks);
}

// ---------------------------------------------------------------- calendar file for one task

function icsForTask(task) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cadence//EN', 'BEGIN:VEVENT', `UID:${task.id}@cadence`, `DTSTAMP:${stamp(new Date())}`, `SUMMARY:${escapeText(task.title)}`];
  if (task.time) {
    const [h, m] = task.time.split(':').map(Number);
    const start = fromISODate(task.due); start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + (task.durationMin || 30) * 60000);
    lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
  } else {
    const d = task.due.replace(/-/g, '');
    const next = toISODate(addDays(fromISODate(task.due), 1)).replace(/-/g, '');
    lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
  }
  if (task.notes) lines.push(`DESCRIPTION:${escapeText(task.notes)}`);
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(task.title)}`, `TRIGGER:-PT${task.time ? state.settings.reminderLead : 0}M`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------- voice

const voice = new VoiceInput({
  lang: state.settings.language,
  onStart: () => { state.listening = true; renderMicState('Listening'); },
  onInterim: (text) => { el('transcript').textContent = text; el('transcript').classList.add('interim'); },
  onFinal: (text) => {
    el('transcript').textContent = text;
    el('transcript').classList.remove('interim');
    if (!state.settings.continuous) voice.stop();
    handleInput(text);
  },
  onEnd: () => { state.listening = false; if (!state.thinking) renderMicState('Ready'); },
  onError: (err) => {
    state.listening = false;
    const messages = {
      unsupported: 'Voice input is not supported in this browser. Use Chrome on Android or Safari on iPhone, or type instead.',
      'not-allowed': 'Microphone access was blocked. Allow the microphone for Cadence in your phone settings, or type instead.',
      'service-not-allowed': 'Speech recognition is unavailable here. Try Chrome or Safari, or type instead.',
      'audio-capture': 'No microphone was found.',
      network: 'Speech recognition needs a network connection on this device.',
    };
    renderMicState('Ready');
    toast(messages[err] || `Voice error: ${err}`, { duration: 7000 });
  },
});

function renderMicState(status) {
  const listening = state.listening;
  el('micBtn').classList.toggle('active', listening);
  el('micBtn').setAttribute('aria-pressed', String(listening));
  el('captureStatus').textContent = listening ? (state.settings.continuous ? 'Listening continuously' : 'Listening') : status;
  el('captureDot').classList.toggle('live', listening);
  el('captureMic').textContent = listening ? 'Stop listening' : 'Start listening';
  if (!listening) el('transcript').classList.remove('interim');
}

function startListening() {
  if (!voiceSupported) {
    openCapture({ focusInput: true });
    toast('Voice input is not available in this browser. You can type instead.', { duration: 6000 });
    return;
  }
  openCapture();
  stopSpeaking();
  el('transcript').textContent = state.settings.continuous ? 'Listening. Say tasks one after another.' : 'Listening.';
  el('transcript').classList.add('interim');
  maybeBrief(() => voice.start({ continuous: state.settings.continuous }));
}

function stopListening() {
  voice.stop();
  state.listening = false;
  renderMicState('Ready');
}

function maybeBrief(then) {
  const t = todayISO();
  if (state.settings.morningBriefing && state.briefedOn !== t && speechSupported) {
    state.briefedOn = t;
    localStorage.setItem('cadence.briefedOn', t);
    const { text, html } = readBack({ scope: 'today' });
    showResult(html);
    speak(`Good ${now().getHours() < 12 ? 'morning' : now().getHours() < 18 ? 'afternoon' : 'evening'}. ${text}`, { lang: state.settings.language, onEnd: then });
  } else {
    then();
  }
}

// ---------------------------------------------------------------- sheets

function anySheetOpen() {
  return ['captureSheet', 'taskSheet', 'remindSheet', 'confirmSheet'].some((id) => !el(id).hidden);
}

function openCapture({ focusInput = false } = {}) {
  el('captureSheet').hidden = false;
  el('backdrop').hidden = false;
  el('captureContext').textContent = state.view === 'calendar' && state.selectedDate !== todayISO() ? `Adding to ${formatDate(state.selectedDate, now())}` : '';
  if (focusInput) setTimeout(() => el('typeInput').focus(), 50);
}

function closeCapture() {
  el('captureSheet').hidden = true;
  el('captureResult').hidden = true;
  state.pending = null;
  if (state.listening) stopListening();
  if (!anySheetOpen()) el('backdrop').hidden = true;
}

function openTaskSheet(task) {
  state.editingId = task ? task.id : null;
  const exists = Boolean(task && state.tasks.some((x) => x.id === task.id));
  el('taskSheetTitle').textContent = exists ? 'Edit task' : 'New task';
  const t = task || { title: '', due: null, time: null, priority: 'normal', repeat: null, durationMin: null, tags: [], notes: '', remind: state.settings.remindByDefault };
  el('tTitle').value = t.title;
  el('tDate').value = t.due || '';
  el('tTime').value = t.time || '';
  el('tRemind').checked = t.remind !== false;
  document.querySelector(`#tPriority input[value="${t.priority}"]`).checked = true;
  el('tRepeat').value = t.repeat || '';
  el('tDuration').value = t.durationMin || '';
  el('tTags').value = (t.tags || []).join(', ');
  el('tNotes').value = t.notes || '';
  el('taskDelete').hidden = !exists;
  el('taskComplete').hidden = !exists || Boolean(task.completedAt);
  el('taskCalendar').hidden = !(exists && task.due);
  el('taskSheet').hidden = false;
  el('backdrop').hidden = false;
}

function closeTaskSheet() {
  el('taskSheet').hidden = true;
  state.editingId = null;
  if (!anySheetOpen()) el('backdrop').hidden = true;
}

function readTaskSheet() {
  const title = el('tTitle').value.trim();
  const due = el('tDate').value || null;
  let time = el('tTime').value || null;
  if (time && time.length > 5) time = time.slice(0, 5);
  return {
    title,
    due: due || (time ? todayISO() : null),
    time,
    remind: el('tRemind').checked,
    priority: document.querySelector('#tPriority input:checked').value,
    repeat: el('tRepeat').value || null,
    durationMin: Number(el('tDuration').value) || null,
    tags: el('tTags').value.split(/[,\s]+/).map((x) => x.replace(/^#/, '').trim().toLowerCase()).filter(Boolean),
    notes: el('tNotes').value.trim(),
  };
}

function saveTaskSheet() {
  const fields = readTaskSheet();
  if (!fields.title) { el('tTitle').focus(); return; }
  const existing = state.editingId && state.tasks.find((t) => t.id === state.editingId);
  if (existing) { patchTask(existing, fields); toast('Saved', { action: 'Undo', onAction: undo }); }
  else { addTasks([fields], 'text'); toast(`Added "${fields.title}"`, { action: 'Undo', onAction: undo }); }
  closeTaskSheet();
}

// ---------------------------------------------------------------- rendering

const VIEW_TITLES = { list: 'Tasks', calendar: 'Calendar', insights: 'Insights', settings: 'Settings' };

function setView(view) {
  if (!VIEW_TITLES[view]) return;
  state.view = view;
  render();
  el('view').scrollTop = 0;
  if (view === 'settings' && API) refreshServerStatus();
}

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  el('viewTitle').textContent = VIEW_TITLES[state.view];
  el('undoBtn').hidden = !state.undo.length;
  const open = openTasks();
  const dueToday = open.filter((t) => t.due && t.due <= todayISO()).length;
  const nxt = state.view === 'list' ? nextReminder() : null;
  const nextHtml = nxt && nxt.at.getTime() - Date.now() < 86400000 ? ` · ${esc(nxt.task.title)} ${countdownSpan(nxt.at, 'countdown inline')}` : '';
  const subtitle = {
    list: (open.length ? `${open.length} open · ${dueToday} due today` : 'Nothing open. Tap the microphone to add a task.') + nextHtml,
    calendar: esc(formatLongDate(state.selectedDate)),
    insights: 'Your last 30 days',
    settings: `Cadence ${APP_VERSION}`,
  }[state.view];
  el('viewSubtitle').innerHTML = subtitle;
  const v = el('view');
  if (state.view === 'list') v.innerHTML = renderList();
  else if (state.view === 'calendar') v.innerHTML = renderCalendar();
  else if (state.view === 'insights') v.innerHTML = renderInsights();
  else v.innerHTML = renderSettings();
  el('searchBtn').classList.toggle('active', Boolean(state.search));
}

function taskRow(task, { showDate = true } = {}) {
  const overdue = isOverdue(task);
  const meta = [];
  if (showDate && task.due) meta.push(`<span class="${overdue ? 'overdue' : ''}">${esc(formatDate(task.due, now()))}</span>`);
  if (task.time) meta.push(`<span class="${overdue ? 'overdue' : ''}">${esc(formatTime(task.time, state.settings.hour12))}</span>`);
  if (task.durationMin) meta.push(`<span>${esc(formatDuration(task.durationMin))}</span>`);
  if (!task.completedAt) { const at = reminderMoment(task); const cd = at ? countdownSpan(at) : ''; if (cd) meta.push(cd); }
  if (task.repeat) meta.push(`<span class="with-icon"><svg><use href="#i-repeat"/></svg>${esc(REPEAT_LABELS[task.repeat])}</span>`);
  if (task.due && !task.completedAt && task.remind === false) meta.push('<span class="with-icon off" title="No reminder"><svg><use href="#i-bell-off"/></svg>No reminder</span>');
  task.tags.forEach((t) => meta.push(`<span class="tag">${esc(t)}</span>`));
  if (task.notes) meta.push(`<span class="muted">${esc(task.notes.length > 60 ? task.notes.slice(0, 60) + '…' : task.notes)}</span>`);
  return `<li class="task prio-${task.priority} ${task.completedAt ? 'done' : ''}" data-id="${task.id}">
    <button class="check" data-action="toggle" aria-label="${task.completedAt ? 'Reopen' : 'Complete'} ${esc(task.title)}"><svg><use href="#i-check"/></svg></button>
    <div class="task-body" data-action="edit">
      <div class="task-title">${esc(task.title)}</div>
      ${meta.length ? `<div class="task-meta">${meta.join('<i class="sep"></i>')}</div>` : ''}
    </div>
  </li>`;
}

function renderList() {
  const t = todayISO();
  const tomorrow = toISODate(addDays(now(), 1));
  const weekEnd = toISODate(addDays(now(), 6));
  let open = openTasks().filter((x) => matchesSearch(x, state.search));
  const allTags = [...new Set(openTasks().flatMap((x) => x.tags))].sort();
  const f = state.listFilter;
  if (f === 'today') open = open.filter((x) => x.due && x.due <= t);
  else if (f === 'upcoming') open = open.filter((x) => x.due && x.due > t);
  else if (f === 'nodate') open = open.filter((x) => !x.due);
  else if (f === 'high') open = open.filter((x) => x.priority === 'high');
  else if (f === 'overdue') open = open.filter(isOverdue);
  else if (f.startsWith('tag:')) open = open.filter((x) => x.tags.includes(f.slice(4)));

  const chips = [['all', 'All'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['high', 'High priority'], ['nodate', 'No date'], ...allTags.map((tag) => ['tag:' + tag, '#' + tag])];
  const chipsHtml = `<div class="chips" role="tablist">${chips.map(([k, label]) => `<button class="chip ${f === k ? 'active' : ''}" data-filter="${esc(k)}" role="tab">${esc(label)}</button>`).join('')}</div>`;

  const groups = [
    { key: 'overdue', label: 'Overdue', items: [] }, { key: 'today', label: 'Today', items: [] }, { key: 'tomorrow', label: 'Tomorrow', items: [] },
    { key: 'week', label: 'Next 7 days', items: [] }, { key: 'later', label: 'Later', items: [] }, { key: 'nodate', label: 'No date', items: [] },
  ];
  for (const task of open.sort(sortTasks)) {
    if (!task.due) groups[5].items.push(task);
    else if (isOverdue(task) && task.due < t) groups[0].items.push(task);
    else if (task.due === t) groups[1].items.push(task);
    else if (task.due === tomorrow) groups[2].items.push(task);
    else if (task.due <= weekEnd) groups[3].items.push(task);
    else groups[4].items.push(task);
  }
  let body = groups.filter((g) => g.items.length).map((g) => `
    <section class="group">
      <h2 class="group-title">${g.label}<span class="count">${g.items.length}</span></h2>
      <ul class="tasks">${g.items.map((x) => taskRow(x, { showDate: !['today', 'tomorrow'].includes(g.key) })).join('')}</ul>
    </section>`).join('');
  if (!body) {
    body = `<div class="empty">
      <p class="empty-title">${state.search || f !== 'all' ? 'No matching tasks' : 'Nothing here yet'}</p>
      <p class="muted">${state.search || f !== 'all' ? 'Try a different filter or search.' : voiceSupported ? 'Tap the microphone and say something like "Remind me tomorrow at 8 pm to wash the dishes".' : 'Use the keyboard button to type your first task.'}</p>
    </div>`;
  }
  const done = completedTasks().filter((x) => matchesSearch(x, state.search)).sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  const doneHtml = state.settings.showCompleted && done.length ? `
    <section class="group completed-group">
      <button class="group-title toggle" data-action="toggle-completed" aria-expanded="${state.completedOpen}">Completed<span class="count">${done.length}</span><svg class="chev ${state.completedOpen ? 'open' : ''}"><use href="#i-right"/></svg></button>
      ${state.completedOpen ? `<ul class="tasks">${done.slice(0, 50).map((x) => taskRow(x)).join('')}</ul><button class="btn text small" data-action="clear-completed">Clear completed</button>` : ''}
    </section>` : '';
  return chipsHtml + body + doneHtml;
}

function renderCalendar() {
  const m = state.calMonth;
  const year = m.getFullYear();
  const month = m.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weekStart = state.settings.weekStart;
  const lead = (first.getDay() - weekStart + 7) % 7;
  const t = todayISO();
  const counts = {};
  for (const task of state.tasks) {
    if (!task.due) continue;
    counts[task.due] = counts[task.due] || { open: 0, high: 0, done: 0 };
    if (task.completedAt) counts[task.due].done += 1;
    else { counts[task.due].open += 1; if (task.priority === 'high') counts[task.due].high += 1; }
  }
  const headers = [];
  for (let i = 0; i < 7; i += 1) headers.push(`<div class="dow">${WEEKDAYS_SHORT[(weekStart + i) % 7]}</div>`);
  const cells = [];
  const startDate = addDays(first, -lead);
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  for (let i = 0; i < total; i += 1) {
    const d = addDays(startDate, i);
    const iso = toISODate(d);
    const inMonth = d.getMonth() === month;
    const c = counts[iso];
    const dots = c ? `<div class="dots">${c.high ? '<i class="dot-high"></i>' : ''}${c.open - c.high > 0 ? '<i class="dot-open"></i>' : ''}${c.done && !c.open ? '<i class="dot-done"></i>' : ''}</div>` : '';
    cells.push(`<button class="day ${inMonth ? '' : 'outside'} ${iso === t ? 'today' : ''} ${iso === state.selectedDate ? 'selected' : ''} ${iso < t ? 'past' : ''}" data-date="${iso}" aria-label="${esc(formatLongDate(iso))}${c ? `, ${c.open} open` : ''}">
      <span class="num">${d.getDate()}</span>${dots}${c && c.open ? `<span class="badge">${c.open}</span>` : ''}
    </button>`);
  }
  const dayTasks = tasksForDate(state.selectedDate);
  const openForDay = dayTasks.filter((x) => !x.completedAt);
  const doneForDay = dayTasks.filter((x) => x.completedAt);
  const totalMin = openForDay.reduce((s, x) => s + (x.durationMin || 0), 0);
  const agenda = `<section class="agenda">
    <div class="agenda-head">
      <h2>${esc(formatDate(state.selectedDate, now()))}<span class="muted"> ${esc(formatLongDate(state.selectedDate).split(', ')[1])}</span></h2>
      <span class="muted">${openForDay.length ? `${openForDay.length} open${totalMin ? ' · ' + formatDuration(totalMin) + ' planned' : ''}` : 'Free'}</span>
    </div>
    ${openForDay.length ? `<ul class="tasks">${openForDay.map((x) => taskRow(x, { showDate: false })).join('')}</ul>` : '<p class="muted agenda-empty">Nothing scheduled. Speak or type a task while this day is selected to add it here.</p>'}
    ${doneForDay.length ? `<ul class="tasks done-list">${doneForDay.map((x) => taskRow(x, { showDate: false })).join('')}</ul>` : ''}
    <button class="btn secondary block" data-action="add-for-day">Add a task for this day</button>
  </section>`;
  return `<div class="cal">
    <div class="cal-nav">
      <button class="icon-btn" data-action="cal-prev" aria-label="Previous month"><svg><use href="#i-left"/></svg></button>
      <h2>${cap(MONTHS[month])} ${year}</h2>
      <button class="icon-btn" data-action="cal-next" aria-label="Next month"><svg><use href="#i-right"/></svg></button>
      <button class="btn text small" data-action="cal-today">Today</button>
    </div>
    <div class="cal-grid" id="calGrid">${headers.join('')}${cells.join('')}</div>
  </div>${agenda}`;
}

function renderInsights() {
  const t = todayISO();
  const open = openTasks();
  const done = completedTasks();
  const overdue = open.filter(isOverdue).length;
  const dueToday = open.filter((x) => x.due && x.due <= t).length;
  const weekAgo = toISODate(addDays(now(), -6));
  const doneThisWeek = done.filter((x) => x.completedAt.slice(0, 10) >= weekAgo).length;
  const monthAgo = toISODate(addDays(now(), -29));
  const recent = state.tasks.filter((x) => (x.due && x.due >= monthAgo && x.due <= t) || (x.completedAt && x.completedAt.slice(0, 10) >= monthAgo));
  const rate = recent.length ? Math.round((recent.filter((x) => x.completedAt).length / recent.length) * 100) : null;
  const doneDays = new Set(done.map((x) => x.completedAt.slice(0, 10)));
  let streak = 0;
  let cursor = doneDays.has(t) ? now() : addDays(now(), -1);
  while (doneDays.has(toISODate(cursor))) { streak += 1; cursor = addDays(cursor, -1); }
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const iso = toISODate(addDays(now(), -i));
    days.push({ iso, n: done.filter((x) => x.completedAt.slice(0, 10) === iso).length });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  const byDow = [0, 0, 0, 0, 0, 0, 0];
  done.forEach((x) => { byDow[new Date(x.completedAt).getDay()] += 1; });
  const bestDow = byDow.some(Boolean) ? WEEKDAYS[byDow.indexOf(Math.max(...byDow))] : null;
  const tagCounts = {};
  open.forEach((x) => x.tags.forEach((tag) => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }));
  const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const tagMax = Math.max(1, ...tags.map((x) => x[1]));
  const highOpen = open.filter((x) => x.priority === 'high').length;
  const voiceShare = state.tasks.length ? Math.round((state.tasks.filter((x) => x.source === 'voice').length / state.tasks.length) * 100) : 0;
  return `
    <div class="stats">
      <div class="stat"><span class="stat-n">${open.length}</span><span class="stat-l">Open</span></div>
      <div class="stat"><span class="stat-n">${dueToday}</span><span class="stat-l">Due today</span></div>
      <div class="stat ${overdue ? 'warn' : ''}"><span class="stat-n">${overdue}</span><span class="stat-l">Overdue</span></div>
      <div class="stat"><span class="stat-n">${doneThisWeek}</span><span class="stat-l">Done this week</span></div>
      <div class="stat"><span class="stat-n">${streak}</span><span class="stat-l">Day streak</span></div>
      <div class="stat"><span class="stat-n">${rate === null ? '–' : rate + '%'}</span><span class="stat-l">Completion, 30 days</span></div>
    </div>
    <section class="panel">
      <h2>Completed, last 14 days</h2>
      <div class="bars" role="img" aria-label="Completed tasks per day for the last 14 days">
        ${days.map((d) => `<div class="bar-col"><div class="bar ${d.n ? '' : 'zero'}" style="height:${Math.round((d.n / max) * 100)}%" title="${d.iso}: ${d.n}"></div><span class="bar-l">${d.iso === t ? 'T' : WEEKDAYS_SHORT[fromISODate(d.iso).getDay()][0]}</span></div>`).join('')}
      </div>
    </section>
    <section class="panel">
      <h2>Open tasks by tag</h2>
      ${tags.length ? tags.map(([tag, n]) => `<div class="hbar"><span class="hbar-l">#${esc(tag)}</span><div class="hbar-track"><div class="hbar-fill" style="width:${Math.round((n / tagMax) * 100)}%"></div></div><span class="hbar-n">${n}</span></div>`).join('') : '<p class="muted">Add tags by saying "tag work" at the end of a task.</p>'}
    </section>
    <section class="panel">
      <h2>Patterns</h2>
      <ul class="facts">
        <li><span>Most productive day</span><strong>${bestDow ? cap(bestDow) : '–'}</strong></li>
        <li><span>High priority open</span><strong>${highOpen}</strong></li>
        <li><span>Added by voice</span><strong>${voiceShare}%</strong></li>
        <li><span>Total completed</span><strong>${done.length}</strong></li>
      </ul>
    </section>`;
}

function renderPushDiagnostics() {
  const st = state.serverStatus;
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const fmtAt = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${formatDate(toISODate(d), now())} ${formatTime(toTimeString(d.getHours(), d.getMinutes()), state.settings.hour12)}`; };
  const rows = [
    ['Opened from home screen', standalone ? 'Yes' : 'No (needed on iPhone)'],
    ['Notification permission', perm],
    ['This phone subscribed', state.push === 'on' ? 'Yes' : 'No'],
    ['Server knows this phone', st ? (st.subscribed ? `Yes, via ${st.pushService || 'push service'}` : 'No') : 'Not checked yet'],
    ['Reminders scheduled on server', st ? String(st.scheduled) : '–'],
    ['Next reminder', st && st.next ? `${st.next.title} · ${fmtAt(st.next.at)}` : '–'],
    ['Last reminder sent', st && st.lastDelivery ? `${st.lastDelivery.title} · ${fmtAt(st.lastDelivery.at)} · push service answered ${st.lastDelivery.status}` : 'None yet'],
    ['Last test', st && st.lastTest ? `${fmtAt(st.lastTest.at)} · push service answered ${st.lastTest.status}` : (state.lastTest && state.lastTest.error ? state.lastTest.error : 'None yet')],
  ];
  return `<ul class="facts diag">${rows.map(([k, v]) => `<li><span>${esc(k)}</span><strong>${esc(v)}</strong></li>`).join('')}</ul>`;
}

function renderSettings() {
  const s = state.settings;
  const sw = (key, label, hint = '') => `<label class="row"><div><span class="row-l">${label}</span>${hint ? `<span class="row-h">${hint}</span>` : ''}</div><input type="checkbox" class="switch" data-setting="${key}" ${s[key] ? 'checked' : ''}></label>`;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const langs = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['pt-BR', 'Portuguese (Brazil)'], ['it-IT', 'Italian'], ['nl-NL', 'Dutch']];

  const claudePill = !API ? '<span class="pill warn">Not set up</span>'
    : state.server === 'off' ? '<span class="pill warn">Unavailable</span>'
      : state.server === 'unknown' ? '<span class="pill">Checking</span>'
        : s.smartParsing ? '<span class="pill on">On</span>' : '<span class="pill">Off</span>';
  const claudeHint = !API ? 'The app is running without its server, so the built-in understanding is used. See the README to deploy the server.'
    : state.server === 'off' ? 'The server is not answering, so the built-in understanding is used for now.'
      : 'Claude works out dates, times, priorities and commands from what you say. It runs on the app’s own server; nobody needs an account.';

  const pushPill = state.push === 'on' ? '<span class="pill on">On</span>'
    : state.push === 'needs_install' ? '<span class="pill warn">Add to Home Screen first</span>'
      : state.push === 'denied' ? '<span class="pill warn">Blocked in phone settings</span>'
        : state.push === 'unsupported' ? '<span class="pill warn">Unavailable here</span>'
          : '<span class="pill">Off</span>';
  const pushHint = !API ? 'Reminders outside the app need the server. Until then, reminders show while the app is open.'
    : state.push === 'on' ? 'Every task with a date rings your phone at its time, or at the daily reminder time when it has no time, even with the app closed.'
      : state.push === 'needs_install' ? 'On iPhone: tap Share in Safari, then "Add to Home Screen", then open Cadence from the home screen and turn reminders on here.'
        : state.push === 'denied' ? 'Notifications were blocked. Allow them for Cadence in your phone’s notification settings, then turn reminders on here.'
          : state.push === 'unsupported' ? 'This browser cannot deliver notifications when the app is closed.'
            : 'Turn on to be notified at each task’s time, even when the app is closed and the phone is locked.';

  return `
    <section class="panel">
      <h2>Reminders</h2>
      <div class="status-line"><div><span class="row-l">Phone notifications${pushPill}</span><span class="row-h">${pushHint}</span></div></div>
      <div class="btn-row">
        ${state.push === 'on' ? '<button class="btn primary small" data-action="push-test">Send a test notification</button><button class="btn secondary small" data-action="push-off">Turn off reminders</button>' : API ? '<button class="btn primary small" data-action="push-on">Turn on reminders</button>' : ''}
        ${API ? '<button class="btn text small" data-action="push-status">Refresh status</button>' : ''}
      </div>
      ${API ? renderPushDiagnostics() : ''}
      ${sw('remindByDefault', 'Remind me for every new task', 'Switch a single task’s reminder off when you edit it')}
      <label class="row"><div><span class="row-l">Daily reminder time</span><span class="row-h">For tasks that have a date but no time</span></div>
        <input type="time" data-setting="dailyReminderTime" value="${esc(s.dailyReminderTime)}"></label>
      <label class="row"><div><span class="row-l">Timed tasks ring</span></div>
        <select data-setting="reminderLead">${[0, 5, 10, 15, 30, 60].map((v) => `<option value="${v}" ${s.reminderLead === v ? 'selected' : ''}>${v === 0 ? 'At the time' : v + ' min before'}</option>`).join('')}</select></label>
    </section>
    <section class="panel">
      <h2>Understanding</h2>
      <div class="status-line"><div><span class="row-l">Claude${claudePill}</span><span class="row-h">${claudeHint}</span></div></div>
      ${API ? sw('smartParsing', 'Use Claude to understand speech', 'Turn off to use the faster built-in rules only') : ''}
      ${sw('confirmBeforeAdd', 'Review before saving', 'Show the understood task and ask before it is added')}
    </section>
    <section class="panel">
      <h2>Voice</h2>
      ${sw('voiceFeedback', 'Spoken confirmations', 'Reads back what was added or changed')}
      ${sw('continuous', 'Hands-free mode', 'Keep listening after each task until you say "stop"')}
      ${sw('morningBriefing', 'Daily briefing', 'Reads today’s tasks the first time you tap the microphone each day')}
      <label class="row"><div><span class="row-l">Recognition language</span></div>
        <select data-setting="language">${langs.map(([v, l]) => `<option value="${v}" ${s.language === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="row-note">${voiceSupported ? 'Voice input is available in this browser.' : 'Voice input is not supported in this browser. Chrome on Android and Safari on iPhone work best.'}</p>
    </section>
    <section class="panel">
      <h2>Appearance</h2>
      <div class="row"><div><span class="row-l">Theme</span></div>
        <div class="segmented small">${['system', 'light', 'dark'].map((v) => `<label><input type="radio" name="theme" value="${v}" data-setting="theme" ${s.theme === v ? 'checked' : ''}><span>${cap(v)}</span></label>`).join('')}</div></div>
      ${sw('hour12', '12-hour clock')}
      <div class="row"><div><span class="row-l">Week starts on</span></div>
        <div class="segmented small">${[[1, 'Monday'], [0, 'Sunday']].map(([v, l]) => `<label><input type="radio" name="weekStart" value="${v}" data-setting="weekStart" ${s.weekStart === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      ${sw('showCompleted', 'Show completed section in list')}
    </section>
    <section class="panel">
      <h2>Install on your phone</h2>
      ${standalone ? '<p class="row-note">Installed. You are running Cadence as an app.</p>' : state.installPrompt ? '<button class="btn primary block" data-action="install">Install Cadence</button>' : isIOS
        ? '<p class="row-note">In Safari, tap the Share button, then "Add to Home Screen". The app opens full screen and can deliver reminders.</p>'
        : '<p class="row-note">In Chrome, open the browser menu and choose "Add to Home screen" or "Install app".</p>'}
    </section>
    <section class="panel">
      <h2>Data</h2>
      <p class="row-note">Your tasks are stored on this phone. They stay until you delete them. Save a backup before switching phones.</p>
      <div class="btn-row">
        <button class="btn secondary small" data-action="export">Save a backup</button>
        <button class="btn secondary small" data-action="import">Restore a backup</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
      <div class="btn-row">
        <button class="btn secondary small" data-action="clear-completed">Clear completed</button>
        <button class="btn danger-text small" data-action="delete-all">Delete all tasks</button>
      </div>
      <p class="row-note">Clearing and deleting always ask for confirmation, and can be undone right after.</p>
    </section>
    <section class="panel">
      <h2>Shortcuts</h2>
      <ul class="facts">
        <li><span>Space</span><strong>Start or stop listening</strong></li>
        <li><span>N</span><strong>Type a task</strong></li>
        <li><span>/</span><strong>Search</strong></li>
        <li><span>1 to 4</span><strong>Switch views</strong></li>
        <li><span>Esc</span><strong>Close</strong></li>
      </ul>
    </section>
    <p class="about muted">Cadence ${APP_VERSION}. Speech recognition is provided by your browser and may send audio to its vendor for processing. What you say is sent to the app’s server only to be understood, and task titles with their times only to deliver reminders.</p>`;
}

// ---------------------------------------------------------------- theme, install

function applyTheme() {
  const t = state.settings.theme;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]:not([media])') || (() => { const m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); return m; })();
  meta.content = dark ? '#0f1115' : '#ffffff';
}

// ---------------------------------------------------------------- events

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  el('micBtn').addEventListener('click', () => (state.listening ? stopListening() : startListening()));
  el('captureMic').addEventListener('click', () => (state.listening ? stopListening() : startListening()));
  el('captureClose').addEventListener('click', closeCapture);
  el('backdrop').addEventListener('click', () => {
    if (!el('confirmSheet').hidden) return;
    closeCapture(); closeTaskSheet(); closeRemindSheet();
  });
  el('typeBtn').addEventListener('click', () => openCapture({ focusInput: true }));
  el('undoBtn').addEventListener('click', undo);

  el('typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = el('typeInput').value;
    el('typeInput').value = '';
    el('transcript').textContent = v;
    handleInput(v);
  });

  el('captureResult').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pending]');
    if (!b || !state.pending) return;
    if (b.dataset.pending === 'save') {
      const created = addTasks(state.pending, 'voice');
      state.pending = null;
      showResult(created.map((t) => resultCard('Added', t)).join(''));
      toast(created.length === 1 ? `Added "${created[0].title}"` : `Added ${created.length} tasks`, { action: 'Undo', onAction: undo });
      say(created.length === 1 ? `Added ${created[0].title}` : `Added ${created.length} tasks`);
    } else if (b.dataset.pending === 'edit') {
      const first = state.pending[0];
      state.pending = null;
      el('captureResult').hidden = true;
      openTaskSheet({ ...first, id: 'draft' });
    } else {
      state.pending = null;
      el('captureResult').hidden = true;
      el('transcript').textContent = 'Discarded.';
    }
  });

  el('searchBtn').addEventListener('click', () => {
    const bar = el('searchBar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) { setView('list'); el('searchInput').focus(); }
    else { state.search = ''; el('searchInput').value = ''; render(); }
  });
  el('searchInput').addEventListener('input', (e) => { state.search = e.target.value.trim(); state.view = 'list'; render(); });
  el('searchClear').addEventListener('click', () => { el('searchBar').hidden = true; if (!state.search) return; state.search = ''; el('searchInput').value = ''; render(); });

  el('view').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-filter]');
    if (chip) { state.listFilter = chip.dataset.filter; render(); return; }
    const day = e.target.closest('.day[data-date]');
    if (day) {
      state.selectedDate = day.dataset.date;
      const d = fromISODate(day.dataset.date);
      state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
      return;
    }
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const row = e.target.closest('.task[data-id]');
    const task = row ? state.tasks.find((t) => t.id === row.dataset.id) : null;
    switch (action) {
      case 'toggle':
        if (!task) return;
        if (task.completedAt) { reopenTask(task); toast('Reopened', { action: 'Undo', onAction: undo }); }
        else { completeTask(task); toast(`Completed "${task.title}"`, { action: 'Undo', onAction: undo }); }
        break;
      case 'edit': if (task) openTaskSheet(task); break;
      case 'toggle-completed': state.completedOpen = !state.completedOpen; render(); break;
      case 'clear-completed': await applyCommand({ type: 'clearCompleted' }); break;
      case 'cal-prev': state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); render(); break;
      case 'cal-next': state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); render(); break;
      case 'cal-today': state.selectedDate = todayISO(); state.calMonth = new Date(now().getFullYear(), now().getMonth(), 1); render(); break;
      case 'add-for-day': openTaskSheet({ title: '', due: state.selectedDate, time: null, priority: 'normal', repeat: null, durationMin: null, tags: [], notes: '', remind: state.settings.remindByDefault, id: 'draft' }); break;
      case 'export': downloadText(`cadence-backup-${todayISO()}.json`, exportData(state.tasks, state.settings), 'application/json'); break;
      case 'import': el('importFile').click(); break;
      case 'delete-all': await applyCommand({ type: 'deleteAll' }); break;
      case 'push-on': enableReminders(); break;
      case 'push-off': disableReminders(); break;
      case 'push-test': await testReminder(); break;
      case 'push-status': await refreshServerStatus(); toast('Status refreshed'); break;
      case 'install':
        if (state.installPrompt) { state.installPrompt.prompt(); state.installPrompt.userChoice.then(() => { state.installPrompt = null; render(); }); }
        break;
      default: break;
    }
  });

  el('view').addEventListener('change', (e) => {
    const input = e.target.closest('[data-setting]');
    if (input) {
      const key = input.dataset.setting;
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else value = input.value;
      if (key === 'weekStart' || key === 'reminderLead') value = Number(value);
      if (key === 'dailyReminderTime' && !/^\d{2}:\d{2}$/.test(value)) return;
      updateSettings({ [key]: value });
      return;
    }
    if (e.target.id === 'importFile' && e.target.files[0]) {
      const file = e.target.files[0];
      file.text().then((text) => {
        try {
          const data = importData(text);
          const existing = new Set(state.tasks.map((t) => t.id));
          const fresh = data.tasks.filter((t) => !existing.has(t.id));
          commit(() => { state.tasks.push(...fresh); });
          toast(`Restored ${fresh.length} tasks`, { action: 'Undo', onAction: undo });
        } catch (err) {
          toast(`Restore failed: ${err.message}`, { duration: 7000 });
        }
      });
      e.target.value = '';
    }
  });

  let touchX = null;
  el('view').addEventListener('touchstart', (e) => { touchX = e.target.closest('#calGrid') ? e.touches[0].clientX : null; }, { passive: true });
  el('view').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) < 60) return;
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + (dx < 0 ? 1 : -1), 1);
    render();
  }, { passive: true });

  el('taskForm').addEventListener('submit', (e) => { e.preventDefault(); saveTaskSheet(); });
  el('taskClose').addEventListener('click', closeTaskSheet);
  el('taskDelete').addEventListener('click', async () => {
    const t = state.tasks.find((x) => x.id === state.editingId);
    if (!t) { closeTaskSheet(); return; }
    const ok = await confirmAction({ title: `Delete "${t.title}"?`, message: 'You can undo this right after.', okLabel: 'Delete' });
    if (!ok) return;
    deleteTask(t);
    toast(`Deleted "${t.title}"`, { action: 'Undo', onAction: undo });
    closeTaskSheet();
  });
  el('taskComplete').addEventListener('click', () => {
    const t = state.tasks.find((x) => x.id === state.editingId);
    if (t) { completeTask(t); toast(`Completed "${t.title}"`, { action: 'Undo', onAction: undo }); }
    closeTaskSheet();
  });
  el('taskCalendar').addEventListener('click', () => {
    const t = state.tasks.find((x) => x.id === state.editingId);
    if (t && t.due) downloadText(`${t.title.replace(/[^\w]+/g, '-').toLowerCase() || 'task'}.ics`, icsForTask(t), 'text/calendar');
  });
  el('taskSheet').addEventListener('click', (e) => {
    const q = e.target.closest('[data-quick]');
    if (!q) return;
    const map = { today: todayISO(), tomorrow: toISODate(addDays(now(), 1)), nextweek: toISODate(addDays(now(), 7)), none: '' };
    el('tDate').value = map[q.dataset.quick];
    if (q.dataset.quick === 'none') el('tTime').value = '';
  });

  el('remindLater').addEventListener('click', () => { updateSettings({ remindPrompted: true }); closeRemindSheet(); });
  el('remindOn').addEventListener('click', async () => { closeRemindSheet(); await enableReminders(); });

  el('confirmCancel').addEventListener('click', () => closeConfirm(false));
  el('confirmOk').addEventListener('click', () => closeConfirm(true));

  document.addEventListener('keydown', (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName);
    if (e.key === 'Escape') { if (!el('confirmSheet').hidden) closeConfirm(false); closeCapture(); closeTaskSheet(); closeRemindSheet(); el('searchBar').hidden = true; return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); if (state.listening) stopListening(); else startListening(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openCapture({ focusInput: true }); }
    else if (e.key === '/') { e.preventDefault(); el('searchBar').hidden = false; setView('list'); el('searchInput').focus(); }
    else if (e.key === 'z' || e.key === 'Z') undo();
    else if (['1', '2', '3', '4'].includes(e.key)) setView(['list', 'calendar', 'insights', 'settings'][Number(e.key) - 1]);
  });

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; if (state.view === 'settings') render(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); checkRemindersLocally(); } });
}

// ---------------------------------------------------------------- init

function init() {
  applyTheme();
  bindEvents();
  render();
  renderMicState('Ready');
  checkRemindersLocally();
  setInterval(checkRemindersLocally, 30000);
  setInterval(tickCountdowns, 1000);
  setInterval(() => { if (state.view !== 'settings') render(); }, 5 * 60000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then(() => restorePushState()).catch((e) => console.warn('Service worker registration failed', e));
  } else {
    state.push = 'unsupported';
  }
  probeServer();

  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'speak') {
    history.replaceState(null, '', location.pathname);
    openCapture();
    el('transcript').textContent = 'Tap "Start listening" to speak.';
  }
}

init();
window.cadence = { state, parseInput, parseTask, handleInput };

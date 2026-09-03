// ---- artifact/app.js ----
// Cadence, Claude Artifact edition. Runs inside claude.ai:
//   sample  -> Claude understands what you say (viewer's own account)
//   db      -> each person's tasks live in the artifact database, per profile
//   mcp     -> reminders are filed into the viewer's Google Calendar
//   downloads -> backups
// Every capability is optional: without them the page still works from
// local storage with the built-in parser.

const APP_VERSION = '2.0.0';
const CALENDAR_SERVER = 'Google Calendar';
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const ARTIFACT_DEFAULTS = { ...DEFAULT_SETTINGS, reminderLead: 0, smartParsing: true, calendarSync: true };

const state = {
  tasks: loadTasks(),
  settings: { ...ARTIFACT_DEFAULTS, ...loadSettings() },
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
  briefedOn: localStorage.getItem('cadence.briefedOn') || '',
  // capabilities
  db: null,
  sample: null,
  mcp: null,
  downloads: null,
  capsResolved: false,
  smart: 'unknown',        // unknown | on | off
  calendar: 'unknown',     // unknown | connected | not_connected | needs_reauth | blocked | unavailable
  profile: null,           // { slug, name }
  unsubscribe: null,
  remoteReady: false,
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

function localOffsetISO(due, time) {
  // "2026-09-04" + "20:00" -> "2026-09-04T20:00:00-05:00" in the viewer's zone.
  const [y, m, d] = due.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const date = new Date(y, m - 1, d, h, mi, 0, 0);
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${due}T${time}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function timeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- persistence: local cache + artifact db

function taskDoc(id) { return state.db.collection(`profiles/${state.profile.slug}/tasks`).doc(id); }

function persistDiff(prev, next) {
  saveTasks(next);
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const nextById = new Map(next.map((t) => [t.id, t]));
  const writes = [];
  for (const t of next) {
    const before = prevById.get(t.id);
    if (!before || JSON.stringify(before) !== JSON.stringify(t)) {
      if (state.db && state.profile) writes.push(taskDoc(t.id).set(t));
      syncCalendar(t, before || null);
    }
  }
  for (const t of prev) {
    if (!nextById.has(t.id)) {
      if (state.db && state.profile) writes.push(taskDoc(t.id).delete());
      if (t.calendarEventId) removeCalendarEvent(t.calendarEventId);
    }
  }
  if (writes.length) {
    Promise.allSettled(writes).then((results) => {
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) {
        const code = failed.reason && failed.reason.code;
        if (code === 'quota_exceeded') toast('Storage is full. Clear completed tasks to make room.', { duration: 8000 });
        else if (code !== 'revoked') toast('Could not save to the shared list. Changes are kept on this device.', { duration: 6000 });
      }
    });
  }
}

function commit(mutator) {
  const prev = state.tasks.map((t) => ({ ...t, tags: [...t.tags] }));
  state.undo.push(JSON.stringify(prev));
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  const result = mutator();
  persistDiff(prev, state.tasks);
  render();
  return result;
}

function undo() {
  if (!state.undo.length) { toast('Nothing to undo'); return false; }
  const prev = state.tasks;
  state.redo.push(JSON.stringify(prev));
  state.tasks = JSON.parse(state.undo.pop());
  persistDiff(prev, state.tasks);
  render();
  toast('Undone');
  return true;
}

function redo() {
  if (!state.redo.length) { toast('Nothing to redo'); return false; }
  const prev = state.tasks;
  state.undo.push(JSON.stringify(prev));
  state.tasks = JSON.parse(state.redo.pop());
  persistDiff(prev, state.tasks);
  render();
  toast('Redone');
  return true;
}

function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  if (state.db && state.profile) {
    state.db.doc(`profiles/${state.profile.slug}`).update({ settings: state.settings }).catch(() => {});
  }
  applyTheme();
  voice.setLanguage(state.settings.language);
  render();
}

// Quietly attach data to a task without creating an undo step (calendar ids).
function annotateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  saveTasks(state.tasks);
  if (state.db && state.profile) taskDoc(id).set(t).catch(() => {});
}

// ---------------------------------------------------------------- task operations

function addTasks(parsedTasks, source = 'text') {
  const created = parsedTasks.map((p) => {
    const fields = { ...p, source };
    if (!fields.due && state.view === 'calendar' && state.selectedDate !== todayISO()) fields.due = state.selectedDate;
    return createTask(fields);
  });
  commit(() => { state.tasks.push(...created); });
  return created;
}

function completeTask(task) {
  commit(() => {
    const t = state.tasks.find((x) => x.id === task.id);
    if (!t) return;
    t.completedAt = new Date().toISOString();
    if (t.repeat) {
      const due = nextOccurrence(t, now());
      if (due) state.tasks.push(createTask({ ...t, due, completedAt: null, notifiedAt: null, calendarEventId: null }));
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
    if (t) Object.assign(t, patch, { notifiedAt: patch.due || patch.time ? null : t.notifiedAt });
  });
}

function findTask(query, { includeCompleted = false } = {}) {
  const pool = includeCompleted ? state.tasks : openTasks();
  return findBestMatch(query, pool);
}

// ---------------------------------------------------------------- Google Calendar reminders

function calendarActive() {
  return Boolean(state.mcp) && state.settings.calendarSync && !['not_connected', 'needs_reauth', 'blocked', 'unavailable'].includes(state.calendar);
}

function handleCalendarError(e, what) {
  const code = e && e.code;
  switch (code) {
    case 'server_not_connected':
    case 'selection_required':
      state.calendar = 'not_connected';
      toast('Add Google Calendar in claude.ai Settings, Connectors, to get reminders on your phone.', { duration: 8000 });
      break;
    case 'needs_reauth':
      state.calendar = 'needs_reauth';
      toast('Reconnect Google Calendar in claude.ai Settings, Connectors.', { duration: 8000 });
      break;
    case 'not_in_manifest':
    case 'blocked_by_policy':
    case 'approval_required':
      state.calendar = 'blocked';
      toast('Calendar reminders are not allowed for this account.', { duration: 6000 });
      break;
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      state.calendar = 'unavailable';
      break;
    case 'tool_error':
      toast(`Google Calendar could not ${what}: ${e.message || 'unknown error'}`, { duration: 7000 });
      break;
    case 'cancelled':
      break;
    default:
      toast(`Could not reach Google Calendar to ${what}. The task is saved; the phone reminder is not.`, { duration: 7000 });
  }
  if (state.view === 'settings') render();
}

async function syncCalendar(task, before) {
  if (!state.mcp) return;
  const wants = Boolean(task.due && task.time && !task.completedAt) && state.settings.calendarSync;
  const had = Boolean(task.calendarEventId);
  if (!wants) {
    if (had) {
      await removeCalendarEvent(task.calendarEventId);
      annotateTask(task.id, { calendarEventId: null });
    }
    return;
  }
  if (!calendarActive()) return;
  const changed = !before || before.due !== task.due || before.time !== task.time || before.title !== task.title
    || before.durationMin !== task.durationMin || before.notes !== task.notes;
  if (had && !changed) return;

  const start = localOffsetISO(task.due, task.time);
  const endDate = new Date(fromISODate(task.due));
  const [h, m] = task.time.split(':').map(Number);
  endDate.setHours(h, m + (task.durationMin || 30), 0, 0);
  const end = localOffsetISO(toISODate(endDate), toTimeString(endDate.getHours(), endDate.getMinutes()));
  const reminders = [{ method: 'popup', minutes: 0 }];
  if (state.settings.reminderLead > 0) reminders.unshift({ method: 'popup', minutes: state.settings.reminderLead });
  const body = {
    summary: task.title,
    description: (task.notes ? task.notes + '\n\n' : '') + 'Reminder from Cadence.',
    startTime: start,
    endTime: end,
    timeZone: timeZoneName(),
    overrideReminders: reminders,
    availability: 'AVAILABILITY_FREE',
  };
  try {
    if (had) {
      await state.mcp.callTool(CALENDAR_SERVER, 'update_event', { eventId: task.calendarEventId, ...body, notificationLevel: 'NONE' });
    } else {
      const result = await state.mcp.callTool(CALENDAR_SERVER, 'create_event', body);
      const payload = result && result.payload;
      const id = payload && typeof payload === 'object' ? payload.id : null;
      if (id) annotateTask(task.id, { calendarEventId: String(id) });
      state.calendar = 'connected';
    }
  } catch (e) {
    handleCalendarError(e, had ? 'update the reminder' : 'set the reminder');
  }
}

async function removeCalendarEvent(eventId) {
  if (!state.mcp || !eventId) return;
  try {
    await state.mcp.callTool(CALENDAR_SERVER, 'delete_event', { eventId, notificationLevel: 'NONE' });
  } catch (e) {
    if (e && e.code === 'tool_error') return; // already gone
    handleCalendarError(e, 'remove the reminder');
  }
}

async function probeCalendar() {
  if (!state.mcp) { state.calendar = 'unavailable'; return; }
  try {
    const { servers } = await state.mcp.listTools();
    const cal = servers.find((s) => s.server === CALENDAR_SERVER);
    if (!cal || !cal.tools.length) state.calendar = 'not_connected';
    else if (cal.authStatus === 'needs_reauth') state.calendar = 'needs_reauth';
    else state.calendar = 'connected';
  } catch (e) {
    handleCalendarError(e, 'check the connection');
  }
  if (state.view === 'settings') render();
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
  const calNote = task.calendarEventId ? ' · Calendar reminder set' : '';
  return `<div class="result-card"><span class="result-label">${esc(label)}</span><div><div class="result-title">${esc(task.title)}</div><div class="result-meta">${esc(describeTask(task)) || 'No date'}${esc(calNote)}</div></div></div>`;
}

// Custom confirmation sheet (window.confirm is not available inside the viewer).
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
  if (el('captureSheet').hidden && el('taskSheet').hidden && el('profileSheet').hidden) el('backdrop').hidden = true;
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

// ---------------------------------------------------------------- Claude understanding

function buildPrompt(text) {
  const d = now();
  const stamp = `${WEEKDAYS[d.getDay()]} ${toISODate(d)} ${toTimeString(d.getHours(), d.getMinutes())}`;
  const open = openTasks().sort(sortTasks).slice(0, 80)
    .map((t) => `${t.id} | ${t.title}${t.due ? ' | ' + t.due : ''}${t.time ? ' ' + t.time : ''}`).join('\n');
  return `You are the command interpreter for a voice to-do app. The user spoke (speech-to-text, so expect typos and slang like "tmr") and you must turn it into JSON actions.

Current local date and time: ${stamp} (time zone ${timeZoneName()}). Week starts Monday. "Tomorrow" is ${toISODate(addDays(d, 1))}.

Open tasks (id | title | date time):
${open || '(none)'}

Reply with ONLY a JSON object of this shape:
{"actions":[...], "say":"one short spoken confirmation"}

Action types:
- {"type":"add","tasks":[{"title":"Wash the car","due":"YYYY-MM-DD"|null,"time":"HH:MM"|null,"priority":"high"|"normal"|"low","tags":["work"],"repeat":null|"daily"|"weekdays"|"every2days"|"weekly"|"biweekly"|"monthly"|"yearly","durationMin":null|number,"notes":""}]}
- {"type":"complete","id":"<task id>"}   also for "done with", "check off", "finished"
- {"type":"reopen","id":"<task id>"}
- {"type":"delete","id":"<task id>"}
- {"type":"reschedule","id":"<task id>","due":"YYYY-MM-DD"|null,"time":"HH:MM"|null}
- {"type":"setPriority","id":"<task id>","priority":"high"|"normal"|"low"}
- {"type":"rename","id":"<task id>","title":"New title"}
- {"type":"read","scope":"today"|"tomorrow"|"week"|"nextweek"|"overdue"|"all"|"date","date":"YYYY-MM-DD"}   when the user asks what they have
- {"type":"navigate","view":"list"|"calendar"|"insights"|"settings"}
- {"type":"clearCompleted"}
- {"type":"undo"}
- {"type":"none","reason":"why nothing could be done"}

Rules:
- Titles are short and imperative, in normal capitalisation, with all date, time and reminder words removed. "add wash the car at 8pm tmr night and remind me at 8" is ONE task: title "Wash the car", due tomorrow, time "20:00".
- "Remind me to X at T" means task X with time T. A bare hour with no am/pm: 1-6 means afternoon or evening, 7-11 means morning, unless the words night, evening, tonight, morning or afternoon say otherwise. "Tonight" is today at 19:00 unless a time is given.
- A time with no date means today if that time is still ahead, otherwise tomorrow.
- Create several tasks only when the user clearly lists separate things ("and also", "and then", "plus").
- For complete, delete, reschedule and similar, pick the open task whose title best matches what the user said. If nothing matches, use {"type":"none"}.
- "say" is one natural sentence, like "Added wash the car, tomorrow at 8 PM." For read requests, list the tasks in "say".
- Use 24-hour "HH:MM" for time and ISO dates.

User said: "${text.replace(/"/g, '\\"')}"`;
}

function normalizeSmart(out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.actions)) return null;
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const actions = [];
  for (const a of out.actions) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') continue;
    const task = a.id ? byId.get(String(a.id)) : null;
    switch (a.type) {
      case 'add': {
        const tasks = (Array.isArray(a.tasks) ? a.tasks : []).map((t) => ({
          title: String(t.title || '').trim(),
          due: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due || '')) ? t.due : null,
          time: /^\d{2}:\d{2}$/.test(String(t.time || '')) ? t.time : null,
          priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
          tags: Array.isArray(t.tags) ? t.tags.map((x) => String(x).toLowerCase().replace(/^#/, '')).filter(Boolean) : [],
          repeat: REPEAT_LABELS[t.repeat] ? t.repeat : null,
          durationMin: Number(t.durationMin) > 0 ? Math.round(Number(t.durationMin)) : null,
          notes: String(t.notes || '').trim(),
        })).filter((t) => t.title);
        if (tasks.length) actions.push({ type: 'add', tasks });
        break;
      }
      case 'complete': case 'reopen': case 'delete': case 'setPriority': case 'rename':
        if (task) actions.push({ ...a, task });
        else if (a.query) actions.push({ ...a, query: String(a.query) });
        break;
      case 'reschedule':
        if (task) actions.push({ type: 'reschedule', task, due: /^\d{4}-\d{2}-\d{2}$/.test(String(a.due || '')) ? a.due : null, time: /^\d{2}:\d{2}$/.test(String(a.time || '')) ? a.time : null });
        break;
      case 'read': case 'navigate': case 'clearCompleted': case 'undo': case 'none':
        actions.push(a);
        break;
      default: break;
    }
  }
  return { actions, say: typeof out.say === 'string' ? out.say.trim() : '' };
}

async function smartParse(text) {
  if (!state.sample || !state.settings.smartParsing || state.smart === 'off') return null;
  try {
    const out = await state.sample.json(buildPrompt(text), { modelTier: 'quick', cache: false });
    const norm = normalizeSmart(out);
    if (norm) state.smart = 'on';
    return norm;
  } catch (e) {
    const code = e && e.code;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
      state.smart = 'off';
      toast('Claude is not available here, so the built-in understanding is used instead.', { duration: 6000 });
    } else if (code === 'rate_limited') {
      toast('Claude is busy right now. Using the built-in understanding for this one.', { duration: 5000 });
    } else if (code !== 'cancelled') {
      toast('Claude did not answer, so the built-in understanding was used.', { duration: 5000 });
    }
    return null;
  }
}

// ---------------------------------------------------------------- command handling

const LOCAL_ONLY = new Set(['navigate', 'undo', 'redo', 'stop', 'theme', 'search']);

async function handleInput(raw, source = 'text') {
  const text = String(raw || '').trim();
  if (!text) return;
  const local = parseInput(text, now());
  if (LOCAL_ONLY.has(local.type)) { await applyCommand(local); return; }

  let cmds = null;
  let sayText = '';
  if (state.sample && state.settings.smartParsing && state.smart !== 'off') {
    setThinking(true);
    const smart = await smartParse(text);
    setThinking(false);
    if (smart && smart.actions.length) { cmds = smart.actions; sayText = smart.say; }
    else if (smart && !smart.actions.length) { cmds = [{ type: 'none', reason: smart.say || 'Nothing to do' }]; sayText = smart.say; }
  }
  if (!cmds) cmds = [local];

  let replies = [];
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

// ---------------------------------------------------------------- voice

const voice = new VoiceInput({
  lang: state.settings.language,
  onStart: () => { state.listening = true; renderMicState('Listening'); },
  onInterim: (text) => { el('transcript').textContent = text; el('transcript').classList.add('interim'); },
  onFinal: (text) => {
    el('transcript').textContent = text;
    el('transcript').classList.remove('interim');
    if (!state.settings.continuous) voice.stop();
    handleInput(text, 'voice');
  },
  onEnd: () => { state.listening = false; if (!state.thinking) renderMicState('Ready'); },
  onError: (err) => {
    state.listening = false;
    const messages = {
      unsupported: 'Voice input is not supported in this browser. You can type instead.',
      'not-allowed': 'The microphone is blocked here. Allow it for this page in your browser settings, or type instead.',
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
  return ['captureSheet', 'taskSheet', 'profileSheet', 'confirmSheet'].some((id) => !el(id).hidden);
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
  const t = task || { title: '', due: null, time: null, priority: 'normal', repeat: null, durationMin: null, tags: [], notes: '' };
  el('tTitle').value = t.title;
  el('tDate').value = t.due || '';
  el('tTime').value = t.time || '';
  document.querySelector(`#tPriority input[value="${t.priority}"]`).checked = true;
  el('tRepeat').value = t.repeat || '';
  el('tDuration').value = t.durationMin || '';
  el('tTags').value = (t.tags || []).join(', ');
  el('tNotes').value = t.notes || '';
  el('taskDelete').hidden = !exists;
  el('taskComplete').hidden = !exists || Boolean(task.completedAt);
  const note = el('taskCalendarNote');
  if (exists && task.calendarEventId) { note.hidden = false; note.textContent = 'A reminder for this task is in your Google Calendar. It moves when you change the date or time.'; }
  else note.hidden = true;
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

// ---------------------------------------------------------------- profiles (who is using the page)

function slugify(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'me';
}

function rememberProfile(p) {
  state.profile = p;
  try { localStorage.setItem('cadence.profile', JSON.stringify(p)); } catch { /* ignore */ }
}

function savedProfile() {
  try { return JSON.parse(localStorage.getItem('cadence.profile') || 'null'); } catch { return null; }
}

async function listProfiles() {
  try {
    const snap = await state.db.collection('profiles').limit(200).get();
    return snap.docs.filter((d) => d.exists).map((d) => ({ slug: d.id, ...(d.data() || {}) }));
  } catch { return []; }
}

let profileMode = { step: 'pick', pending: null };

async function showProfileSheet() {
  profileMode = { step: 'pick', pending: null };
  el('profileTitle').textContent = 'Who is this?';
  el('profileHint').textContent = 'Each person keeps their own list on this page. Pick your name or add a new one.';
  el('pName').value = '';
  el('pPin').value = '';
  el('pPin').required = false;
  el('pPinLabel').textContent = 'PIN (optional, protects your list)';
  el('profileError').hidden = true;
  el('profileBack').hidden = true;
  el('pName').parentElement.hidden = false;
  el('profileSheet').hidden = false;
  el('backdrop').hidden = false;
  el('backdrop').classList.add('hard');
  const list = el('profileList');
  list.innerHTML = '';
  const profiles = await listProfiles();
  profiles.sort((a, b) => String(a.name || a.slug).localeCompare(String(b.name || b.slug)));
  list.innerHTML = profiles.map((p) => `<button type="button" class="profile-item" data-slug="${esc(p.slug)}"><svg><use href="#i-user"/></svg>${esc(p.name || p.slug)}${p.pinHash ? '<span class="muted">PIN</span>' : ''}</button>`).join('');
}

async function submitProfile() {
  const name = el('pName').value.trim();
  const pin = el('pPin').value.trim();
  const errBox = el('profileError');
  errBox.hidden = true;
  if (profileMode.step === 'pin') {
    const p = profileMode.pending;
    if (!pin) { errBox.textContent = 'Enter the PIN for this list.'; errBox.hidden = false; return; }
    if ((await sha256(pin)) !== p.pinHash) { errBox.textContent = 'That PIN does not match.'; errBox.hidden = false; return; }
    await openProfile({ slug: p.slug, name: p.name });
    return;
  }
  if (!name) { errBox.textContent = 'Enter a name.'; errBox.hidden = false; return; }
  if (pin && !/^\d{4,8}$/.test(pin)) { errBox.textContent = 'A PIN is 4 to 8 digits.'; errBox.hidden = false; return; }
  const slug = slugify(name);
  const ref = state.db.doc(`profiles/${slug}`);
  let existing = null;
  try { const snap = await ref.get(); existing = snap.exists ? snap.data() : null; } catch { existing = null; }
  if (existing) {
    if (existing.pinHash) { askPin({ slug, name: existing.name || name, pinHash: existing.pinHash }); return; }
    await openProfile({ slug, name: existing.name || name });
    return;
  }
  try {
    await ref.set({ name, pinHash: pin ? await sha256(pin) : null, createdAt: new Date().toISOString(), settings: state.settings });
  } catch (e) {
    errBox.textContent = 'Could not create the profile. Check your connection and try again.';
    errBox.hidden = false;
    return;
  }
  await openProfile({ slug, name });
}

function askPin(p) {
  profileMode = { step: 'pin', pending: p };
  el('profileTitle').textContent = `PIN for ${p.name}`;
  el('profileHint').textContent = 'This list is protected. Enter its PIN to open it.';
  el('pName').parentElement.hidden = true;
  el('pPin').value = '';
  el('pPin').required = true;
  el('pPinLabel').textContent = 'PIN';
  el('profileBack').hidden = false;
  el('profileError').hidden = true;
  setTimeout(() => el('pPin').focus(), 50);
}

async function openProfile(p) {
  if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
  rememberProfile(p);
  el('profileSheet').hidden = true;
  el('backdrop').classList.remove('hard');
  if (!anySheetOpen()) el('backdrop').hidden = true;
  state.undo = [];
  state.redo = [];
  state.remoteReady = false;
  // Settings stored with the profile win over the device copy.
  try {
    const snap = await state.db.doc(`profiles/${p.slug}`).get();
    const data = snap.exists ? snap.data() : null;
    if (data && data.settings) { state.settings = { ...ARTIFACT_DEFAULTS, ...data.settings }; saveSettings(state.settings); applyTheme(); }
  } catch { /* keep device settings */ }
  const col = state.db.collection(`profiles/${p.slug}/tasks`);
  state.unsubscribe = col.onSnapshot((snap) => {
    const remote = snap.docs.filter((d) => d.exists).map((d) => sanitizeTaskWithCalendar(d.data()));
    if (!state.remoteReady && remote.length === 0 && state.tasks.length && !localStorage.getItem('cadence.migrated.' + p.slug)) {
      // First open on this device with tasks that were only stored locally: move them into the profile.
      const local = state.tasks;
      localStorage.setItem('cadence.migrated.' + p.slug, '1');
      Promise.allSettled(local.map((t) => col.doc(t.id).set(t))).then(() => { state.remoteReady = true; });
      return;
    }
    state.remoteReady = true;
    state.tasks = remote;
    saveTasks(state.tasks);
    render();
  }, (e) => {
    if (e && e.code === 'revoked') toast('Access to the shared list ended. Reload the page to continue.', { duration: 8000 });
  });
  render();
}

function sanitizeTaskWithCalendar(raw) {
  const t = sanitizeTask(raw);
  t.calendarEventId = raw.calendarEventId ? String(raw.calendarEventId) : null;
  return t;
}

// ---------------------------------------------------------------- rendering

const VIEW_TITLES = { list: 'Tasks', calendar: 'Calendar', insights: 'Insights', settings: 'Settings' };

function setView(view) {
  if (!VIEW_TITLES[view]) return;
  state.view = view;
  render();
  el('view').scrollTop = 0;
}

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  el('viewTitle').textContent = VIEW_TITLES[state.view];
  el('undoBtn').hidden = !state.undo.length;
  const open = openTasks();
  const dueToday = open.filter((t) => t.due && t.due <= todayISO()).length;
  const who = state.profile ? ` · ${state.profile.name}` : '';
  const subtitle = {
    list: (open.length ? `${open.length} open · ${dueToday} due today` : 'Nothing open. Tap the microphone to add a task.') + who,
    calendar: formatLongDate(state.selectedDate),
    insights: 'Your last 30 days' + who,
    settings: `Cadence ${APP_VERSION}${who}`,
  }[state.view];
  el('viewSubtitle').textContent = subtitle;
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
  if (task.repeat) meta.push(`<span class="with-icon"><svg><use href="#i-repeat"/></svg>${esc(REPEAT_LABELS[task.repeat])}</span>`);
  if (task.calendarEventId && !task.completedAt) meta.push('<span class="with-icon" title="Reminder in Google Calendar"><svg><use href="#i-bell"/></svg>Reminder</span>');
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
      <p class="muted">${state.search || f !== 'all' ? 'Try a different filter or search.' : 'Tap the microphone and say something like "Remind me tomorrow at 8 pm to wash the dishes".'}</p>
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

function renderSettings() {
  const s = state.settings;
  const sw = (key, label, hint = '') => `<label class="row"><div><span class="row-l">${label}</span>${hint ? `<span class="row-h">${hint}</span>` : ''}</div><input type="checkbox" class="switch" data-setting="${key}" ${s[key] ? 'checked' : ''}></label>`;
  const langs = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['pt-BR', 'Portuguese (Brazil)'], ['it-IT', 'Italian'], ['nl-NL', 'Dutch']];

  const smartPill = !state.capsResolved ? '<span class="pill">Checking</span>'
    : !state.sample ? '<span class="pill warn">Unavailable here</span>'
      : state.smart === 'off' ? '<span class="pill warn">Not allowed</span>'
        : s.smartParsing ? '<span class="pill on">On</span>' : '<span class="pill">Off</span>';
  const calPill = !state.capsResolved ? '<span class="pill">Checking</span>'
    : !state.mcp || state.calendar === 'unavailable' ? '<span class="pill warn">Unavailable here</span>'
      : state.calendar === 'not_connected' ? '<span class="pill warn">Not connected</span>'
        : state.calendar === 'needs_reauth' ? '<span class="pill warn">Reconnect needed</span>'
          : state.calendar === 'blocked' ? '<span class="pill warn">Blocked</span>'
            : s.calendarSync ? '<span class="pill on">Connected</span>' : '<span class="pill">Off</span>';
  const calHint = state.calendar === 'not_connected' ? 'Add Google Calendar in claude.ai Settings, Connectors, then reload this page.'
    : state.calendar === 'needs_reauth' ? 'Reconnect Google Calendar in claude.ai Settings, Connectors.'
      : 'Every task with a time becomes a calendar event with an alert, so your phone rings even when this page is closed.';
  const storagePill = !state.capsResolved ? '<span class="pill">Checking</span>' : state.db ? '<span class="pill on">Saved online</span>' : '<span class="pill warn">This device only</span>';

  return `
    <section class="panel">
      <h2>Understanding</h2>
      <div class="status-line"><div><span class="row-l">Claude${smartPill}</span><span class="row-h">${state.sample ? 'Uses your Claude account to understand what you say. Dates, times, priorities and commands are worked out in context.' : 'Open this page inside Claude to let Claude interpret what you say. The built-in understanding is used meanwhile.'}</span></div></div>
      ${sw('smartParsing', 'Use Claude to understand speech', 'Turn off to use the faster built-in rules only')}
      ${sw('confirmBeforeAdd', 'Review before saving', 'Show the understood task and ask before it is added')}
    </section>
    <section class="panel">
      <h2>Reminders</h2>
      <div class="status-line"><div><span class="row-l">Google Calendar${calPill}</span><span class="row-h">${calHint}</span></div></div>
      ${sw('calendarSync', 'Put timed tasks in Google Calendar', 'Reminders arrive from the Calendar app, even with this page closed')}
      <label class="row"><div><span class="row-l">Alert</span></div>
        <select data-setting="reminderLead">${[0, 5, 10, 15, 30, 60].map((v) => `<option value="${v}" ${s.reminderLead === v ? 'selected' : ''}>${v === 0 ? 'At the time' : v + ' min before, and at the time'}</option>`).join('')}</select></label>
      <p class="row-note">Tasks without a time do not get an alert. Say a time, such as "at 8 pm", to be reminded.</p>
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
      <h2>Your list</h2>
      <div class="status-line"><div><span class="row-l">${esc(state.profile ? state.profile.name : 'This device')}${storagePill}</span><span class="row-h">${state.db ? 'Your tasks are saved with your name on this page and stay until you delete them. Anyone you share the link with picks their own name and gets their own list.' : 'Tasks are saved in this browser only.'}</span></div></div>
      ${state.db ? '<div class="btn-row"><button class="btn secondary small" data-action="switch-profile">Switch person</button><button class="btn secondary small" data-action="set-pin">Set or change PIN</button></div>' : ''}
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
      <h2>Data</h2>
      <div class="btn-row">
        ${state.downloads ? '<button class="btn secondary small" data-action="export">Save a backup</button>' : ''}
        <button class="btn secondary small" data-action="import">Restore a backup</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
      <div class="btn-row">
        <button class="btn secondary small" data-action="clear-completed">Clear completed</button>
        <button class="btn danger-text small" data-action="delete-all">Delete all tasks</button>
      </div>
      <p class="row-note">Clearing and deleting always ask for confirmation, and can be undone right after.</p>
    </section>
    <p class="about muted">Cadence ${APP_VERSION}. Speech recognition is provided by your browser and may send audio to its vendor for processing. Nothing else about your tasks leaves this page except what you choose to send to Claude or your calendar.</p>`;
}

// ---------------------------------------------------------------- theme and reminders while open

function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
}

function checkReminders() {
  const n = now();
  let changed = false;
  for (const task of openTasks()) {
    if (!task.due || !task.time || task.notifiedAt) continue;
    const [h, m] = task.time.split(':').map(Number);
    const at = fromISODate(task.due);
    at.setHours(h, m, 0, 0);
    const diffMin = (at - n) / 60000;
    if (diffMin <= state.settings.reminderLead && diffMin > -30) {
      toast(`Reminder: ${task.title} · ${formatTime(task.time, state.settings.hour12)}`, { duration: 15000 });
      say(`Reminder: ${task.title}`);
      task.notifiedAt = n.toISOString();
      changed = true;
    }
  }
  if (changed) saveTasks(state.tasks);
}

async function exportBackup() {
  const data = exportData(state.tasks, state.settings);
  if (state.downloads) {
    try {
      await state.downloads.save({ filename: `cadence-backup-${todayISO()}.json`, data });
      toast('Backup saved');
    } catch (e) {
      if (e && e.code !== 'cancelled') toast('Backup was not saved.');
    }
  }
}

// ---------------------------------------------------------------- events

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  el('micBtn').addEventListener('click', () => (state.listening ? stopListening() : startListening()));
  el('captureMic').addEventListener('click', () => (state.listening ? stopListening() : startListening()));
  el('captureClose').addEventListener('click', closeCapture);
  el('backdrop').addEventListener('click', () => {
    if (!el('profileSheet').hidden || !el('confirmSheet').hidden) return;
    closeCapture(); closeTaskSheet();
  });
  el('typeBtn').addEventListener('click', () => openCapture({ focusInput: true }));
  el('undoBtn').addEventListener('click', undo);

  el('typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = el('typeInput').value;
    el('typeInput').value = '';
    el('transcript').textContent = v;
    handleInput(v, 'text');
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
      case 'add-for-day': openTaskSheet({ title: '', due: state.selectedDate, time: null, priority: 'normal', repeat: null, durationMin: null, tags: [], notes: '', id: 'draft' }); break;
      case 'export': exportBackup(); break;
      case 'import': el('importFile').click(); break;
      case 'delete-all': await applyCommand({ type: 'deleteAll' }); break;
      case 'switch-profile': showProfileSheet(); break;
      case 'set-pin': changePin(); break;
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
      updateSettings({ [key]: value });
      if (key === 'calendarSync' && value) state.tasks.forEach((t) => syncCalendar(t, null));
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
  el('taskSheet').addEventListener('click', (e) => {
    const q = e.target.closest('[data-quick]');
    if (!q) return;
    const map = { today: todayISO(), tomorrow: toISODate(addDays(now(), 1)), nextweek: toISODate(addDays(now(), 7)), none: '' };
    el('tDate').value = map[q.dataset.quick];
    if (q.dataset.quick === 'none') el('tTime').value = '';
  });

  el('profileForm').addEventListener('submit', (e) => { e.preventDefault(); submitProfile(); });
  el('profileBack').addEventListener('click', showProfileSheet);
  el('profileList').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-slug]');
    if (!item) return;
    const slug = item.dataset.slug;
    try {
      const snap = await state.db.doc(`profiles/${slug}`).get();
      const data = snap.exists ? snap.data() : {};
      if (data.pinHash) askPin({ slug, name: data.name || slug, pinHash: data.pinHash });
      else await openProfile({ slug, name: data.name || slug });
    } catch {
      el('profileError').textContent = 'Could not open that list. Try again.';
      el('profileError').hidden = false;
    }
  });

  el('confirmCancel').addEventListener('click', () => closeConfirm(false));
  el('confirmOk').addEventListener('click', () => closeConfirm(true));

  document.addEventListener('keydown', (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName);
    if (e.key === 'Escape') { if (!el('confirmSheet').hidden) closeConfirm(false); closeCapture(); closeTaskSheet(); el('searchBar').hidden = true; return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); if (state.listening) stopListening(); else startListening(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openCapture({ focusInput: true }); }
    else if (e.key === '/') { e.preventDefault(); el('searchBar').hidden = false; setView('list'); el('searchInput').focus(); }
    else if (e.key === 'z' || e.key === 'Z') undo();
    else if (['1', '2', '3', '4'].includes(e.key)) setView(['list', 'calendar', 'insights', 'settings'][Number(e.key) - 1]);
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); checkReminders(); } });
}

async function changePin() {
  if (!state.db || !state.profile) return;
  // Reuse the profile sheet in PIN-setting mode.
  profileMode = { step: 'setpin', pending: null };
  el('profileTitle').textContent = `PIN for ${state.profile.name}`;
  el('profileHint').textContent = 'Enter a new 4 to 8 digit PIN, or leave it empty to remove the PIN.';
  el('pName').parentElement.hidden = true;
  el('pPin').value = '';
  el('pPin').required = false;
  el('pPinLabel').textContent = 'New PIN';
  el('profileBack').hidden = false;
  el('profileError').hidden = true;
  el('profileList').innerHTML = '';
  el('profileSheet').hidden = false;
  el('backdrop').hidden = false;
  const handler = async (e) => {
    e.preventDefault();
    if (profileMode.step !== 'setpin') return;
    const pin = el('pPin').value.trim();
    if (pin && !/^\d{4,8}$/.test(pin)) { el('profileError').textContent = 'A PIN is 4 to 8 digits.'; el('profileError').hidden = false; return; }
    try {
      await state.db.doc(`profiles/${state.profile.slug}`).update({ pinHash: pin ? await sha256(pin) : null });
      toast(pin ? 'PIN set' : 'PIN removed');
    } catch { toast('Could not change the PIN.'); }
    el('profileForm').removeEventListener('submit', handler, true);
    el('profileSheet').hidden = true;
    if (!anySheetOpen()) el('backdrop').hidden = true;
  };
  el('profileForm').addEventListener('submit', handler, true);
  el('profileBack').onclick = () => {
    el('profileForm').removeEventListener('submit', handler, true);
    el('profileSheet').hidden = true;
    if (!anySheetOpen()) el('backdrop').hidden = true;
    el('profileBack').onclick = null;
  };
}

// ---------------------------------------------------------------- capabilities boot

async function bootCapabilities() {
  const has = typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function';
  if (!has) { state.capsResolved = true; render(); return; }
  const use = (name) => window.claude.use(name).catch(() => null);
  const [db, sample, mcp, downloads] = await Promise.all([use('db'), use('sample'), use('mcp'), use('downloads')]);
  state.db = db;
  state.sample = sample;
  state.mcp = mcp;
  state.downloads = downloads;
  state.capsResolved = true;
  if (mcp) probeCalendar();
  if (db) {
    const saved = savedProfile();
    if (saved && saved.slug) await openProfile(saved);
    else showProfileSheet();
  }
  render();
}

// ---------------------------------------------------------------- init

function init() {
  applyTheme();
  bindEvents();
  render();
  renderMicState('Ready');
  checkReminders();
  setInterval(checkReminders, 30000);
  setInterval(() => { if (state.view !== 'settings') render(); }, 5 * 60000);
  bootCapabilities();
}

init();
window.cadence = { state, parseInput, parseTask, handleInput };

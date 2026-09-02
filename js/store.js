// Persistence layer: tasks and settings live in localStorage so the app works
// fully offline and without an account.

import { fromISODate, toISODate, addDays, addMonths } from './dates.js';

const TASKS_KEY = 'cadence.tasks.v1';
const SETTINGS_KEY = 'cadence.settings.v1';

export const DEFAULT_SETTINGS = {
  theme: 'system',            // system | light | dark
  voiceFeedback: true,        // speak short confirmations
  continuous: false,          // keep listening after each task
  language: 'en-US',
  notifications: false,
  reminderLead: 10,           // minutes before a timed task
  hour12: true,
  weekStart: 1,               // 0 = Sunday, 1 = Monday
  showCompleted: true,
  confirmBeforeAdd: false,    // review a parsed task before it is saved
  morningBriefing: false,     // speak today's tasks when the app opens
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function loadTasks() {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(sanitizeTask) : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks) {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  } catch (e) {
    console.warn('Could not save tasks', e);
  }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Could not save settings', e);
  }
}

export function sanitizeTask(t) {
  return {
    id: t.id || uid(),
    title: String(t.title || '').trim(),
    notes: String(t.notes || ''),
    due: t.due || null,
    time: t.time || null,
    priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
    tags: Array.isArray(t.tags) ? t.tags.map((x) => String(x).toLowerCase()) : [],
    repeat: t.repeat || null,
    durationMin: t.durationMin ? Number(t.durationMin) : null,
    createdAt: t.createdAt || new Date().toISOString(),
    completedAt: t.completedAt || null,
    notifiedAt: t.notifiedAt || null,
    source: t.source || 'text',
    order: typeof t.order === 'number' ? t.order : Date.now(),
  };
}

export function createTask(fields) {
  return sanitizeTask({ ...fields, id: uid(), createdAt: new Date().toISOString(), order: Date.now() });
}

// Compute the due date of the next occurrence for a repeating task.
export function nextOccurrence(task, today = new Date()) {
  if (!task.repeat) return null;
  const base = fromISODate(task.due) || today;
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let d = base;
  let guard = 0;
  do {
    switch (task.repeat) {
      case 'daily': d = addDays(d, 1); break;
      case 'every2days': d = addDays(d, 2); break;
      case 'weekdays':
        d = addDays(d, 1);
        while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
        break;
      case 'weekly': d = addDays(d, 7); break;
      case 'biweekly': d = addDays(d, 14); break;
      case 'monthly': d = addMonths(d, 1); break;
      case 'yearly': d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()); break;
      default: return null;
    }
    guard += 1;
  } while (d < todayStart && guard < 500);
  return toISODate(d);
}

export const REPEAT_LABELS = {
  daily: 'Daily',
  every2days: 'Every other day',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

export function exportData(tasks, settings) {
  return JSON.stringify({ app: 'cadence', version: 1, exportedAt: new Date().toISOString(), tasks, settings }, null, 2);
}

export function importData(json) {
  const data = JSON.parse(json);
  const tasks = Array.isArray(data) ? data : data.tasks;
  if (!Array.isArray(tasks)) throw new Error('No tasks found in file');
  return { tasks: tasks.map(sanitizeTask), settings: data.settings || null };
}

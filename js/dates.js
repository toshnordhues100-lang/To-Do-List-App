// Small date helpers. All dates are handled in local time and stored as
// ISO calendar strings (YYYY-MM-DD) and 24h clock strings (HH:MM).

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), lastDay));
  return r;
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

export function toTimeString(h, m) {
  return `${pad(h)}:${pad(m)}`;
}

export function formatTime(t, hour12 = true) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (!hour12) return toTimeString(h, m);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh} ${suffix}` : `${hh}:${pad(m)} ${suffix}`;
}

export function formatDate(iso, now = new Date()) {
  const d = fromISODate(iso);
  if (!d) return '';
  const diff = daysBetween(now, d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()].replace(/^\w/, (c) => c.toUpperCase());
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}${sameYear ? '' : ' ' + d.getFullYear()}`;
}

export function formatLongDate(iso) {
  const d = fromISODate(iso);
  if (!d) return '';
  return `${WEEKDAYS[d.getDay()].replace(/^\w/, (c) => c.toUpperCase())}, ${MONTHS[d.getMonth()].replace(/^\w/, (c) => c.toUpperCase())} ${d.getDate()}`;
}

export function formatDuration(min) {
  if (!min) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

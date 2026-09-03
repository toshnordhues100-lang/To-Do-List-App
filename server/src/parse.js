// Turns a spoken or typed sentence into structured actions using Claude Haiku 4.5,
// the least expensive model: a typical request is under 1,000 tokens in and
// about 100 out, roughly a tenth of a cent.

export const MODEL = 'claude-haiku-4-5';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localParts(nowIso, tz) {
  // Render the current moment in the caller's zone as "Wednesday 2026-09-02 22:41".
  const d = new Date(nowIso);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long' });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  const dayIdx = WEEKDAYS.findIndex((w) => w.toLowerCase() === String(parts.weekday).toLowerCase());
  const tomorrow = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + 1));
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);
  return { date, time, weekday: WEEKDAYS[dayIdx] || parts.weekday, tomorrowIso };
}

export const SYSTEM_PROMPT = `You are the command interpreter for a voice to-do app. The user's words come from speech-to-text, so expect typos and slang like "tmr" for tomorrow. Turn them into JSON actions.

Reply with ONLY a JSON object: {"actions":[...], "say":"one short spoken confirmation"}

Action types:
- {"type":"add","tasks":[{"title":"Wash the car","due":"YYYY-MM-DD"|null,"time":"HH:MM"|null,"priority":"high"|"normal"|"low","tags":["work"],"repeat":null|"daily"|"weekdays"|"every2days"|"weekly"|"biweekly"|"monthly"|"yearly","durationMin":null|number,"notes":""}]}
- {"type":"complete","id":"<task id>"}  for done, finished, check off
- {"type":"reopen","id":"<task id>"}
- {"type":"delete","id":"<task id>"}
- {"type":"reschedule","id":"<task id>","due":"YYYY-MM-DD"|null,"time":"HH:MM"|null}
- {"type":"setPriority","id":"<task id>","priority":"high"|"normal"|"low"}
- {"type":"rename","id":"<task id>","title":"New title"}
- {"type":"read","scope":"today"|"tomorrow"|"week"|"nextweek"|"overdue"|"all"|"date","date":"YYYY-MM-DD"}  when the user asks what they have
- {"type":"navigate","view":"list"|"calendar"|"insights"|"settings"}
- {"type":"clearCompleted"}
- {"type":"undo"}
- {"type":"none","reason":"why nothing could be done"}

Rules:
- Titles are short and imperative with normal capitalisation, and with every date, time and reminder word removed. "add wash the car at 8pm tmr night and remind me at 8" is ONE task: title "Wash the car", due tomorrow, time "20:00".
- "Remind me to X at T" means task X at time T. A bare hour with no am or pm: 1 to 6 means afternoon or evening, 7 to 11 means morning, unless words like night, evening, tonight, morning or afternoon say otherwise. "Tonight" is today at 19:00 unless a time is given.
- A time with no date means today if that time is still ahead, otherwise tomorrow.
- Create several tasks only when the user clearly lists separate things ("and also", "and then", "plus").
- For complete, delete, reschedule and the like, choose the open task whose title best matches. If nothing matches, use {"type":"none"}.
- "say" is one natural sentence such as "Added wash the car, tomorrow at 8 PM." For read requests, list the tasks briefly in "say".
- Use 24-hour "HH:MM" for time and ISO dates.`;

export function buildUserMessage({ text, nowIso, tz, tasks }) {
  const { date, time, weekday, tomorrowIso } = localParts(nowIso, tz);
  const list = (tasks || []).slice(0, 80).map((t) => `${t.id} | ${t.title}${t.due ? ' | ' + t.due : ''}${t.time ? ' ' + t.time : ''}`).join('\n');
  return `Current local date and time: ${weekday} ${date} ${time} (time zone ${tz}). Week starts Monday. Tomorrow is ${tomorrowIso}.

Open tasks (id | title | date time):
${list || '(none)'}

User said: "${String(text).replace(/"/g, '\\"')}"`;
}

export function extractJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

const REPEATS = new Set(['daily', 'weekdays', 'every2days', 'weekly', 'biweekly', 'monthly', 'yearly']);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = (v) => /^\d{2}:\d{2}$/.test(String(v || ''));

export function normalize(out, tasks) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.actions)) return null;
  const ids = new Set((tasks || []).map((t) => String(t.id)));
  const actions = [];
  for (const a of out.actions) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') continue;
    const id = a.id !== undefined && ids.has(String(a.id)) ? String(a.id) : null;
    switch (a.type) {
      case 'add': {
        const list = (Array.isArray(a.tasks) ? a.tasks : []).map((t) => ({
          title: String(t.title || '').trim().slice(0, 200),
          due: isDate(t.due) ? t.due : null,
          time: isTime(t.time) ? t.time : null,
          priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
          tags: Array.isArray(t.tags) ? t.tags.map((x) => String(x).toLowerCase().replace(/^#/, '').slice(0, 30)).filter(Boolean).slice(0, 8) : [],
          repeat: REPEATS.has(t.repeat) ? t.repeat : null,
          durationMin: Number(t.durationMin) > 0 ? Math.round(Number(t.durationMin)) : null,
          notes: String(t.notes || '').trim().slice(0, 1000),
        })).filter((t) => t.title);
        if (list.length) actions.push({ type: 'add', tasks: list });
        break;
      }
      case 'complete': case 'reopen': case 'delete':
        if (id) actions.push({ type: a.type, id });
        break;
      case 'reschedule':
        if (id) actions.push({ type: 'reschedule', id, due: isDate(a.due) ? a.due : null, time: isTime(a.time) ? a.time : null });
        break;
      case 'setPriority':
        if (id && ['high', 'normal', 'low'].includes(a.priority)) actions.push({ type: 'setPriority', id, priority: a.priority });
        break;
      case 'rename':
        if (id && a.title) actions.push({ type: 'rename', id, title: String(a.title).trim().slice(0, 200) });
        break;
      case 'read':
        actions.push({ type: 'read', scope: ['today', 'tomorrow', 'week', 'nextweek', 'overdue', 'all', 'date'].includes(a.scope) ? a.scope : 'today', date: isDate(a.date) ? a.date : null });
        break;
      case 'navigate':
        if (['list', 'calendar', 'insights', 'settings'].includes(a.view)) actions.push({ type: 'navigate', view: a.view });
        break;
      case 'clearCompleted': case 'undo':
        actions.push({ type: a.type });
        break;
      case 'none':
        actions.push({ type: 'none', reason: String(a.reason || '').slice(0, 200) });
        break;
      default: break;
    }
  }
  return { actions, say: typeof out.say === 'string' ? out.say.trim().slice(0, 300) : '' };
}

// `client` is an Anthropic SDK client. Returns {actions, say, usage}.
export async function parseUtterance({ text, nowIso, tz, tasks }, client, { model = MODEL } = {}) {
  const response = await client.messages.create({
    model,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage({ text, nowIso, tz, tasks }) }],
  });
  const textOut = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = normalize(extractJson(textOut), tasks);
  return { ...(parsed || { actions: [], say: '' }), ok: Boolean(parsed), usage: response.usage };
}

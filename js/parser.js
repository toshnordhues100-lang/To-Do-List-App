// Natural-language parser for spoken and typed input.
//
// parseInput("call the dentist tomorrow at 3pm high priority") returns
//   { type: 'add', tasks: [{ title: 'Call the dentist', due: '2026-09-03', time: '15:00', priority: 'high', ... }] }
//
// It also recognises commands such as "complete buy milk", "delete the dentist task",
// "show calendar", "what's on today", "move gym to friday" and "undo".

import { WEEKDAYS, MONTHS, toISODate, addDays, addMonths, daysBetween, toTimeString } from './dates.js';

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};

const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty first': 21, 'twenty second': 22, 'twenty third': 23,
  'twenty fourth': 24, 'twenty fifth': 25, 'twenty sixth': 26, 'twenty seventh': 27, 'twenty eighth': 28,
  'twenty ninth': 29, thirtieth: 30, 'thirty first': 31,
};

const WEEKDAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const MONTH_ALIASES = {};
MONTHS.forEach((m, i) => {
  MONTH_ALIASES[m] = i;
  MONTH_ALIASES[m.slice(0, 3)] = i;
});
MONTH_ALIASES.sept = 8;

const WEEKDAY_RE = '(?:sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?:day|nesday|sday|urday)?';
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*';

// ---------- helpers ----------

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\bhashtag\s+/g, '#')
    .replace(/#\s+/g, '#')
    .replace(/\b(a\.m\.|a\.m)\b/g, 'am')
    .replace(/\b(p\.m\.|p\.m)\b/g, 'pm')
    .replace(/\bo'?clock\b/g, "o'clock")
    .replace(/\btmrw?\b|\btomorow\b/g, 'tomorrow')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberWordsToDigits(text) {
  // "twenty five" -> 25, "twenty" -> 20, "three" -> 3. Only replaces number words
  // in contexts where a number is expected so task titles keep their wording.
  const tens = '(?:twenty|thirty|forty|fifty)';
  const units = '(?:one|two|three|four|five|six|seven|eight|nine)';
  const single = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety|a|an)';
  const numberWord = `(?:${tens}[ -]${units}|${single})`;
  const toNum = (w) => {
    const parts = w.split(/[ -]/);
    return parts.reduce((s, p) => s + (NUMBER_WORDS[p] ?? 0), 0);
  };
  const contexts = [
    new RegExp(`\\b(in|for|every|within)\\s+(${numberWord})\\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\\b`, 'g'),
    new RegExp(`\\b(at|around|by|until|till|before|after)\\s+(${numberWord})(?=\\s*(?:am|pm|o'clock|in the|tonight|tomorrow|today|:|$|\\s))`, 'g'),
    new RegExp(`\\b(${numberWord})\\s*(am|pm|o'clock)\\b`, 'g'),
    new RegExp(`\\b(half past|quarter past|quarter to|quarter till)\\s+(${numberWord})\\b`, 'g'),
  ];
  let out = text;
  out = out.replace(contexts[0], (m, p, n, u) => `${p} ${toNum(n)} ${u}`);
  out = out.replace(contexts[1], (m, p, n) => `${p} ${toNum(n)}`);
  out = out.replace(contexts[2], (m, n, s) => `${toNum(n)} ${s}`);
  out = out.replace(contexts[3], (m, p, n) => `${p} ${toNum(n)}`);
  // Ordinal words: "the fifteenth" -> "the 15th"
  const ordinalKeys = Object.keys(ORDINAL_WORDS).sort((a, b) => b.length - a.length);
  const ord = (n) => `${n}${[1, 21, 31].includes(n) ? 'st' : [2, 22].includes(n) ? 'nd' : [3, 23].includes(n) ? 'rd' : 'th'}`;
  out = out.replace(new RegExp(`\\b((?:on|by|until|till|for|due) the|${MONTH_RE}(?: the)?)\\s+(${ordinalKeys.join('|')})\\b`, 'g'), (m, p, w) => `${p} ${ord(ORDINAL_WORDS[w])}`);
  out = out.replace(new RegExp(`\\b(${ordinalKeys.join('|')})\\s+(of\\s+${MONTH_RE})\\b`, 'g'), (m, w, rest) => `${ord(ORDINAL_WORDS[w])} ${rest}`);
  return out;
}

function cleanTitle(raw) {
  let t = raw
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*,/g, ',')
    .replace(/^[\s,;:\-]+|[\s,;:\-]+$/g, '')
    // dangling prepositions left after removing date/time phrases
    .replace(/\s+(on|at|by|in|for|the|to|until|till|from|and|with|due|around|of|this|next)$/i, '')
    .replace(/^(on|at|by|in|for|to|the|and|due)\s+/i, '')
    .replace(/\s+(on|at|by|in|for|the|to|until|till|from|and|due|around|of|this|next)$/i, '')
    .replace(/\s+(on|at|by|in|for|to|the|and|due)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function resolveHour(h, m, meridiem, period) {
  // Returns [hour24, minute] from a possibly-ambiguous hour.
  if (meridiem === 'am') return [h === 12 ? 0 : h, m];
  if (meridiem === 'pm') return [h === 12 ? 12 : h + 12, m];
  if (h > 12) return [h, m]; // 24h clock
  if (period === 'morning') return [h === 12 ? 0 : h, m];
  if (period === 'afternoon' || period === 'evening' || period === 'night') return [h === 12 ? 12 : h + 12, m];
  // Heuristic: 7-11 -> morning, 12 -> noon, 1-6 -> afternoon/evening
  if (h >= 7 && h <= 11) return [h, m];
  if (h === 12) return [12, m];
  if (h === 0) return [0, m];
  return [h + 12, m];
}

// ---------- extraction ----------

function extractPriority(text) {
  let priority = 'normal';
  let t = text;
  const high = /\b(urgent(?:ly)?|asap|as soon as possible|critical|top priority|high priority|priority high|very important|important|must do|make it high)\b/;
  const low = /\b(low priority|priority low|not urgent|no rush|whenever|someday|when i get a chance|make it low)\b/;
  if (high.test(t)) { priority = 'high'; t = t.replace(high, ' '); }
  else if (low.test(t)) { priority = 'low'; t = t.replace(low, ' '); }
  return { priority, text: t };
}

function extractTags(text) {
  const tags = [];
  let t = text.replace(/#([a-z0-9_-]+)/g, (m, tag) => { tags.push(tag); return ' '; });
  t = t.replace(/\b(?:tag(?:ged)?(?: it| as| with)?|label(?:l?ed)?(?: it| as)?|categor(?:y|ize)(?: as)?|under|in (?:the|my) (?:list|category)?)\s+([a-z0-9_-]+)(?:\s+(?:list|category|tag))?\b/g, (m, tag) => {
    if (['the', 'a', 'my', 'it'].includes(tag)) return m;
    tags.push(tag);
    return ' ';
  });
  return { tags: [...new Set(tags)], text: t };
}

function extractRepeat(text, ctx) {
  let t = text;
  let repeat = null;
  const rules = [
    { re: /\b(every|each) (week ?day|weekdays)\b/, val: 'weekdays' },
    { re: /\b(every|each) (weekend)\b/, val: 'weekly', weekday: 6 },
    { re: /\b(every|each) other day\b/, val: 'every2days' },
    { re: /\b(every|each) other week\b/, val: 'biweekly' },
    { re: /\b(every|each) (morning)\b/, val: 'daily', time: '09:00' },
    { re: /\b(every|each) (afternoon)\b/, val: 'daily', time: '14:00' },
    { re: /\b(every|each) (evening)\b/, val: 'daily', time: '18:00' },
    { re: /\b(every|each) (night)\b/, val: 'daily', time: '21:00' },
    { re: /\b(every|each) (day|single day)\b|\bdaily\b/, val: 'daily' },
    { re: /\b(every|each) (week)\b|\bweekly\b/, val: 'weekly' },
    { re: /\b(every|each) (two|2) weeks\b|\b(bi-?weekly|fortnightly)\b/, val: 'biweekly' },
    { re: /\b(every|each) (month)\b|\bmonthly\b/, val: 'monthly' },
    { re: /\b(every|each) (year)\b|\b(yearly|annually)\b/, val: 'yearly' },
  ];
  for (const rule of rules) {
    if (rule.re.test(t)) {
      repeat = rule.val;
      t = t.replace(rule.re, ' ');
      if (rule.time) ctx.defaultTime = rule.time;
      if (rule.weekday !== undefined) ctx.repeatWeekday = rule.weekday;
      break;
    }
  }
  if (!repeat) {
    const wd = new RegExp(`\\b(every|each) (${WEEKDAY_RE})s?\\b`);
    const m = t.match(wd);
    if (m) {
      repeat = 'weekly';
      ctx.repeatWeekday = WEEKDAY_ALIASES[m[2].replace(/s$/, '')] ?? WEEKDAY_ALIASES[m[2]];
      t = t.replace(wd, ' ');
    }
  }
  return { repeat, text: t };
}

function extractDuration(text) {
  let durationMin = null;
  let t = text;
  const re = /\b(?:for|lasting|takes?|taking)\s+(?:about\s+|around\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/;
  const m = t.match(re);
  if (m) {
    const n = parseFloat(m[1]);
    durationMin = /^h/.test(m[2]) ? Math.round(n * 60) : Math.round(n);
    t = t.replace(re, ' ');
  } else if (/\bfor (half an hour|30 minutes)\b/.test(t)) {
    durationMin = 30; t = t.replace(/\bfor (half an hour|30 minutes)\b/, ' ');
  } else if (/\bfor an hour and a half\b/.test(t)) {
    durationMin = 90; t = t.replace(/\bfor an hour and a half\b/, ' ');
  } else if (/\bfor (an|1) hour\b/.test(t)) {
    durationMin = 60; t = t.replace(/\bfor (an|1) hour\b/, ' ');
  }
  return { durationMin, text: t };
}

function extractTime(text, ctx) {
  let t = text;
  let time = null;
  let period = null;

  // Period of day words (also influence ambiguous hours)
  const periods = [
    { re: /\b(this morning|in the morning|morning)\b/, p: 'morning', h: 9, today: /this morning/ },
    { re: /\b(this afternoon|in the afternoon|afternoon)\b/, p: 'afternoon', h: 14, today: /this afternoon/ },
    { re: /\b(tonight)\b/, p: 'evening', h: 19, today: /tonight/ },
    { re: /\b(this evening|in the evening|evening)\b/, p: 'evening', h: 19, today: /this evening/ },
    { re: /\b(at night|late tonight)\b/, p: 'night', h: 21 },
    { re: /\b(first thing)\b/, p: 'morning', h: 8 },
    { re: /\b(end of (?:the )?day|eod|before bed|close of business|cob)\b/, p: 'evening', h: 17 },
    { re: /\b(after work)\b/, p: 'evening', h: 18 },
    { re: /\b(at lunch ?time|at lunch|lunch ?time)\b/, p: 'afternoon', h: 12 },
    { re: /\b(at )?(noon|midday)\b/, p: 'afternoon', h: 12, exact: true },
    { re: /\b(at )?(midnight)\b/, p: 'night', h: 23, min: 59, exact: true },
  ];
  for (const p of periods) {
    const m = t.match(p.re);
    if (m) {
      period = p.p;
      ctx.defaultTime = toTimeString(p.h, p.min || 0);
      if (p.exact) time = ctx.defaultTime;
      if (p.today && p.today.test(m[0])) ctx.forceToday = true;
      t = t.replace(p.re, ' ');
      break;
    }
  }

  const patterns = [
    // 3:30pm, 3 pm, 15:00, at 3, around 3:15, by 5pm
    { re: /\b(?:at|around|about|by|@|until|till|before|after)?\s*(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/, hasMin: true },
    { re: /\b(?:at|around|about|by|@|until|till|before|after)?\s*(\d{1,2})\s*(am|pm)\b/, hasMin: false },
    { re: /\b(?:at|around|about|by|@|until|till|before|after)\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|\/|-|\d|:|am|pm|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|o'clock|%|dollars|people|percent))/, hasMin: false },
    { re: /\b(\d{1,2})\s*o'clock\b/, hasMin: false },
  ];
  const wordPatterns = [
    { re: /\bhalf past (\d{1,2})\b(?:\s*(am|pm))?/, min: 30 },
    { re: /\bquarter past (\d{1,2})\b(?:\s*(am|pm))?/, min: 15 },
    { re: /\bquarter (?:to|till) (\d{1,2})\b(?:\s*(am|pm))?/, min: 45, before: true },
  ];

  if (!time) {
    for (const wp of wordPatterns) {
      const m = t.match(wp.re);
      if (m) {
        let h = parseInt(m[1], 10);
        if (wp.before) h = h - 1 < 0 ? 23 : h - 1;
        const [hh, mm] = resolveHour(h, wp.min, m[2] || null, period);
        time = toTimeString(hh, mm);
        t = t.replace(wp.re, ' ');
        break;
      }
    }
  }
  if (!time) {
    for (const p of patterns) {
      const m = t.match(p.re);
      if (!m) continue;
      const h = parseInt(m[1], 10);
      const min = p.hasMin ? parseInt(m[2], 10) : 0;
      const mer = p.hasMin ? m[3] : m[2];
      if (h > 23 || min > 59) continue;
      if (mer === undefined && p.hasMin && !/\b(?:at|around|about|by|@|until|till|before|after)\s*\d/.test(m[0]) && h > 23) continue;
      const [hh, mm] = resolveHour(h, min, mer ? mer.replace(/[^ap]/g, '').slice(0, 1) + 'm' : null, period);
      time = toTimeString(hh, mm);
      t = t.replace(p.re, ' ');
      // A "quarter" style time with a time-of-day word right after e.g. "at 3 in the afternoon"
      break;
    }
  }
  return { time, text: t, period };
}

function extractDate(text, now, ctx) {
  let t = text;
  let due = null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const set = (d) => { due = toISODate(d); };

  const nextWeekday = (idx, from = today, includeToday = true) => {
    let diff = (idx - from.getDay() + 7) % 7;
    if (diff === 0 && !includeToday) diff = 7;
    return addDays(from, diff);
  };
  const followingWeekday = (idx) => {
    // "next monday": the one in the following calendar week (weeks start Monday)
    const dow = (today.getDay() + 6) % 7; // 0 = Monday
    const monday = addDays(today, -dow + 7);
    const target = (idx + 6) % 7;
    return addDays(monday, target);
  };

  const rules = [
    { re: /\b(the )?day after tomorrow\b/, fn: () => set(addDays(today, 2)) },
    { re: /\btomorrow\b/, fn: () => set(addDays(today, 1)) },
    { re: /\btoday\b/, fn: () => set(today) },
    { re: /\byesterday\b/, fn: () => set(addDays(today, -1)) },
    { re: /\bin (\d+) (minutes?|mins?)\b/, fn: (m) => { const d = new Date(now.getTime() + parseInt(m[1], 10) * 60000); set(d); ctx.timeFromRelative = toTimeString(d.getHours(), d.getMinutes()); } },
    { re: /\bin (\d+) (hours?|hrs?)\b/, fn: (m) => { const d = new Date(now.getTime() + parseInt(m[1], 10) * 3600000); set(d); ctx.timeFromRelative = toTimeString(d.getHours(), d.getMinutes()); } },
    { re: /\bin (\d+) days?\b/, fn: (m) => set(addDays(today, parseInt(m[1], 10))) },
    { re: /\bin (\d+) weeks?\b/, fn: (m) => set(addDays(today, 7 * parseInt(m[1], 10))) },
    { re: /\bin (\d+) months?\b/, fn: (m) => set(addMonths(today, parseInt(m[1], 10))) },
    { re: /\bin (\d+) years?\b/, fn: (m) => set(new Date(today.getFullYear() + parseInt(m[1], 10), today.getMonth(), today.getDate())) },
    { re: /\b(a|one) week from (today|now)\b/, fn: () => set(addDays(today, 7)) },
    { re: /\b(a|one) week from tomorrow\b/, fn: () => set(addDays(today, 8)) },
    { re: /\bnext week\b/, fn: () => set(followingWeekday(1)) },
    { re: /\bnext weekend\b/, fn: () => set(followingWeekday(6)) },
    { re: /\b(this )?weekend\b/, fn: () => set(nextWeekday(6)) },
    { re: /\bend of (the )?(week|this week)\b/, fn: () => set(nextWeekday(5)) },
    { re: /\bend of (the )?(month|this month)\b/, fn: () => set(new Date(today.getFullYear(), today.getMonth() + 1, 0)) },
    { re: /\bend of (the )?(year|this year)\b/, fn: () => set(new Date(today.getFullYear(), 11, 31)) },
    { re: /\bnext month\b/, fn: () => set(new Date(today.getFullYear(), today.getMonth() + 1, 1)) },
    { re: /\bnext year\b/, fn: () => set(new Date(today.getFullYear() + 1, 0, 1)) },
    { re: /\bthis week\b/, fn: () => set(nextWeekday(5)) },
    { re: /\bthis month\b/, fn: () => set(new Date(today.getFullYear(), today.getMonth() + 1, 0)) },
    // ISO or numeric dates: 2026-10-15, 10/15, 10/15/2026, 10-15
    { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, fn: (m) => set(new Date(+m[1], +m[2] - 1, +m[3])) },
    { re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, fn: (m) => {
      let y = m[3] ? parseInt(m[3], 10) : today.getFullYear();
      if (m[3] && m[3].length === 2) y += 2000;
      let d = new Date(y, +m[1] - 1, +m[2]);
      if (!m[3] && d < today) d = new Date(y + 1, +m[1] - 1, +m[2]);
      set(d);
    } },
    // month day: "october 15", "oct 15th", "october 15 2026"
    { re: new RegExp(`\\b(?:on |by |for )?(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`), fn: (m) => {
      const mi = MONTH_ALIASES[m[1].slice(0, 3)];
      if (mi === undefined) return false;
      let y = m[3] ? +m[3] : today.getFullYear();
      let d = new Date(y, mi, +m[2]);
      if (!m[3] && d < today) d = new Date(y + 1, mi, +m[2]);
      set(d);
    } },
    // day month: "15 october", "15th of october", "the 15th of oct"
    { re: new RegExp(`\\b(?:on |by |for )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTH_RE})\\b(?:,? (\\d{4}))?`), fn: (m) => {
      const mi = MONTH_ALIASES[m[2].slice(0, 3)];
      if (mi === undefined) return false;
      let y = m[3] ? +m[3] : today.getFullYear();
      let d = new Date(y, mi, +m[1]);
      if (!m[3] && d < today) d = new Date(y + 1, mi, +m[1]);
      set(d);
    } },
    // "on the 15th" / "the 15th"
    { re: /\b(?:on |by |for )?the (\d{1,2})(?:st|nd|rd|th)\b/, fn: (m) => {
      let d = new Date(today.getFullYear(), today.getMonth(), +m[1]);
      if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, +m[1]);
      set(d);
    } },
    // weekdays: "next friday", "this friday", "on friday", "friday"
    { re: new RegExp(`\\bnext (${WEEKDAY_RE})\\b`), fn: (m) => set(followingWeekday(WEEKDAY_ALIASES[m[1]] ?? WEEKDAY_ALIASES[m[1].slice(0, 3)])) },
    { re: new RegExp(`\\b(?:on |by |for |this |this coming |coming )?(${WEEKDAY_RE})\\b`), fn: (m) => {
      const idx = WEEKDAY_ALIASES[m[1]] ?? WEEKDAY_ALIASES[m[1].slice(0, 3)];
      if (idx === undefined) return false;
      set(nextWeekday(idx));
    } },
  ];

  for (const rule of rules) {
    const m = t.match(rule.re);
    if (m) {
      const r = rule.fn(m);
      if (r === false) continue;
      t = t.replace(rule.re, ' ');
      break;
    }
  }
  return { due, text: t };
}

// ---------- task parsing ----------

const LEAD_INS = /^(?:(?:please|hey|ok|okay|hi|um|uh|so)\s+)*(?:(?:add|create|new|make|set|schedule|plan|log|put|note|remind me to|remind me|reminder to|reminder|remember to|remember|i need to|i've got to|i have to|i must|i should|i want to|i'd like to|i gotta|got to|gotta|note to self|don't forget to|do not forget to|task|to do|todo|a task to|task to|an? (?:new )?(?:task|todo|reminder|item)(?: to| for)?)[:,]?\s+)+/;

export function parseTask(text, now = new Date()) {
  const ctx = {};
  let t = numberWordsToDigits(normalize(text));
  t = t.replace(LEAD_INS, '');
  t = t.replace(/^(?:that )?(?:i )?(?:need|have) to\s+/, '');

  const pr = extractPriority(t); t = pr.text;
  const tg = extractTags(t); t = tg.text;
  const rp = extractRepeat(t, ctx); t = rp.text;
  const du = extractDuration(t); t = du.text;
  const tm = extractTime(t, ctx); t = tm.text;
  const dt = extractDate(t, now, ctx); t = dt.text;

  // Notes: "note: ..." or "notes ..." or "with note ..."
  let notes = '';
  const noteMatch = t.match(/\b(?:with (?:the )?notes?|notes?|details?|description)[:\s]+(.+)$/);
  if (noteMatch) { notes = noteMatch[1].trim(); t = t.slice(0, noteMatch.index); }

  let time = tm.time || ctx.timeFromRelative || null;
  if (!time && ctx.defaultTime) time = ctx.defaultTime;
  let due = dt.due;

  if (!due && ctx.repeatWeekday !== undefined) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let diff = (ctx.repeatWeekday - today.getDay() + 7) % 7;
    if (diff === 0 && time && time <= toTimeString(now.getHours(), now.getMinutes())) diff = 7;
    due = toISODate(addDays(today, diff));
  }
  if (!due && rp.repeat) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let d = today;
    if (rp.repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) d = addDays(d, d.getDay() === 6 ? 2 : 1);
    if (time && time <= toTimeString(now.getHours(), now.getMinutes()) && toISODate(d) === toISODate(today)) d = addDays(d, 1);
    due = toISODate(d);
  }
  if (!due && ctx.forceToday) due = toISODate(now);
  if (!due && time) {
    // A bare time means today, unless that moment has already passed.
    const nowStr = toTimeString(now.getHours(), now.getMinutes());
    due = toISODate(time > nowStr ? now : addDays(now, 1));
  }

  const title = cleanTitle(t);
  return {
    title,
    due,
    time,
    priority: pr.priority,
    tags: tg.tags,
    repeat: rp.repeat,
    durationMin: du.durationMin,
    notes,
  };
}

// ---------- commands ----------

function splitTasks(text) {
  return text
    .split(/\s*(?:,\s*|;\s*)?\b(?:and then|and also|also|then|plus|as well as|and add|and another|another one|next one|second one|new task)\b\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripTaskWord(s) {
  return s.replace(/^(?:the |my |that |this )?(?:task |item |to ?do |reminder )?(?:called |named |for |to |about |of )?/, '')
    .replace(/\s+(?:task|item|to ?do|reminder|off|as (?:done|complete|completed|finished)|from (?:the |my )?list)$/, '')
    .replace(/^(?:the |my )/, '')
    .trim();
}

const VIEW_WORDS = {
  calendar: 'calendar', month: 'calendar', schedule: 'calendar', agenda: 'calendar',
  list: 'list', tasks: 'list', 'to do list': 'list', 'todo list': 'list', checklist: 'list', 'check list': 'list',
  insights: 'insights', stats: 'insights', statistics: 'insights', progress: 'insights', dashboard: 'insights',
  settings: 'settings', options: 'settings', preferences: 'settings',
  today: 'today', tomorrow: 'tomorrow', overdue: 'overdue', completed: 'completed', done: 'completed',
};

export function parseInput(input, now = new Date()) {
  const raw = normalize(input);
  if (!raw) return { type: 'noop' };
  const t = numberWordsToDigits(raw);
  let m;

  if (/^(?:undo|undo that|undo last|undo the last one|take that back|never ?mind|cancel that)$/.test(t)) return { type: 'undo' };
  if (/^(?:redo|redo that)$/.test(t)) return { type: 'redo' };
  if (/^(?:stop|stop listening|that's all|that is all|that's it|done|finished|goodbye|bye|thanks|thank you)$/.test(t)) return { type: 'stop' };

  // Navigation
  m = t.match(/^(?:show|open|go to|goto|switch to|view|display|take me to)(?: me)?(?: the| my)?\s+(calendar|month|schedule|agenda|list|tasks|to do list|todo list|checklist|check list|insights|stats|statistics|progress|dashboard|settings|options|preferences|today|tomorrow|overdue|completed|done)(?:\s+(?:view|mode|tasks|page|screen))?$/);
  if (m) return { type: 'navigate', view: VIEW_WORDS[m[1]] };
  m = t.match(/^(calendar|list|insights|settings)(?:\s+(?:view|mode))?$/);
  if (m) return { type: 'navigate', view: VIEW_WORDS[m[1]] };

  // Theme
  m = t.match(/^(?:switch to|turn on|enable|use|set)\s+(dark|light|system)\s*(?:mode|theme)?$/);
  if (m) return { type: 'theme', theme: m[1] };

  // Read back
  m = t.match(/^(?:what(?:'s| is| do i have| have i got| am i doing)|what's on|whats on|read(?: me)?|tell me|list|recap|summarize|summary of|brief me on|briefing)(?: my| the| out)?(?: tasks| to ?dos| schedule| plan| agenda| day| list)?(?: (?:for|on|is|are))?(?: (?:planned|scheduled|due|left|open|remaining))?(?: (?:for|on))?\s*(today|tomorrow|this week|the week|overdue|late|next week|everything|all|the rest of the day)?\s*(?:\??)$/);
  if (m) {
    const scope = { undefined: 'today', today: 'today', tomorrow: 'tomorrow', 'this week': 'week', 'the week': 'week', 'next week': 'nextweek', overdue: 'overdue', late: 'overdue', everything: 'all', all: 'all', 'the rest of the day': 'today' }[m[1]];
    return { type: 'read', scope: scope || 'today' };
  }
  m = t.match(/^(?:what(?:'s| is)|read)\s+(?:on|for|due|scheduled)?\s*(?:the |this )?(?:calendar |schedule )?(?:for |on )?(tomorrow|today|.+)$/);
  if (m) {
    const scope = m[1];
    if (scope === 'today' || scope === 'tomorrow') return { type: 'read', scope };
    const d = extractDate(scope, now, {});
    if (d.due) return { type: 'read', scope: 'date', date: d.due };
  }

  // Clear completed
  if (/^(?:clear|remove|delete|purge|archive)\s+(?:all\s+)?(?:the\s+)?(?:completed|done|finished|checked)(?:\s+(?:tasks|items|ones))?$/.test(t)) return { type: 'clearCompleted' };

  // Complete
  m = t.match(/^(?:complete|completed|finish|finished|done with|i finished|i completed|i did|i've done|i have done|check off|check|tick off|tick|mark(?: off)?|mark done|mark complete|cross off|cross out|close|i've finished)\s+(.+)$/);
  if (m) {
    let q = m[1].replace(/^(?:off\s+|done\s+|complete\s+)/, '');
    const queryText = stripTaskWord(q);
    if (queryText === 'everything' || queryText === 'all' || queryText === 'all tasks') return { type: 'completeAll' };
    return { type: 'complete', query: queryText };
  }
  m = t.match(/^(.+?)\s+(?:is|was)\s+(?:done|complete|completed|finished)$/);
  if (m) return { type: 'complete', query: stripTaskWord(m[1]) };

  // Reopen
  m = t.match(/^(?:reopen|uncomplete|uncheck|undo complete|mark (?:as )?(?:incomplete|not done|undone))\s+(.+)$/);
  if (m) return { type: 'reopen', query: stripTaskWord(m[1]) };

  // Delete
  m = t.match(/^(?:delete|remove|cancel|scrap|erase|trash|drop|get rid of|forget about|forget)\s+(.+)$/);
  if (m) {
    const queryText = stripTaskWord(m[1]);
    if (/^(?:everything|all|all tasks|the whole list)$/.test(queryText)) return { type: 'deleteAll' };
    return { type: 'delete', query: queryText };
  }

  // Reschedule: "move gym to friday", "postpone dentist until next week", "push X by 2 days"
  m = t.match(/^(?:move|reschedule|postpone|push(?: back)?|defer|delay|shift|change)\s+(.+?)\s+(?:to|until|till|for|by)\s+(.+)$/);
  if (m) {
    const ctx = {};
    let tail = m[2];
    const tm = extractTime(tail, ctx); tail = tm.text;
    const dt = extractDate(tail, now, ctx);
    let byDays = null;
    const rel = m[2].match(/^(\d+) (days?|weeks?)$/);
    if (rel) byDays = parseInt(rel[1], 10) * (rel[2].startsWith('week') ? 7 : 1);
    if (dt.due || tm.time || byDays) {
      return { type: 'reschedule', query: stripTaskWord(m[1]), due: dt.due, time: tm.time || ctx.timeFromRelative || ctx.defaultTime || null, byDays };
    }
  }

  // Priority changes: "make dentist high priority", "set gym to low priority"
  m = t.match(/^(?:make|set|mark|change|flag)\s+(.+?)\s+(?:to |as )?(high|low|normal|medium)\s*priority$/);
  if (m) return { type: 'setPriority', query: stripTaskWord(m[1]), priority: m[2] === 'medium' ? 'normal' : m[2] };
  m = t.match(/^(?:prioritize|prioritise|flag|star)\s+(.+)$/);
  if (m) return { type: 'setPriority', query: stripTaskWord(m[1]), priority: 'high' };

  // Rename: "rename X to Y"
  m = t.match(/^(?:rename|change the name of|retitle)\s+(.+?)\s+to\s+(.+)$/);
  if (m) return { type: 'rename', query: stripTaskWord(m[1]), title: cleanTitle(m[2]) };

  // Search
  m = t.match(/^(?:search(?: for)?|find|look for|look up|filter(?: by)?|show me)\s+(.+)$/);
  if (m) {
    const q = m[1].replace(/^(?:tasks? |everything |all )?(?:about |with |containing |tagged |for |called |named )?/, '').replace(/\s+tasks?$/, '');
    return { type: 'search', query: q };
  }
  if (/^(?:clear search|clear filter|show all|show everything|reset)$/.test(t)) return { type: 'search', query: '' };

  // Default: add one or more tasks
  const parts = splitTasks(t);
  const tasks = parts.map((p) => parseTask(p, now)).filter((task) => task.title);
  if (!tasks.length) return { type: 'noop' };
  return { type: 'add', tasks };
}

// Fuzzy matching of a spoken query against existing task titles.
const STOP = new Set(['the', 'a', 'an', 'to', 'my', 'of', 'for', 'and', 'task', 'item', 'that', 'this', 'on', 'in', 'at', 'with']);

function tokens(s) {
  return normalize(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}

function stem(w) {
  return w.replace(/(ing|ed|es|s)$/, '');
}

export function scoreMatch(query, title) {
  const q = tokens(query).map(stem);
  const tt = tokens(title).map(stem);
  if (!q.length || !tt.length) return 0;
  const normQ = normalize(query);
  const normT = normalize(title);
  if (normQ === normT) return 1;
  if (normT.includes(normQ) || normQ.includes(normT)) return 0.9;
  let hits = 0;
  for (const w of q) {
    if (tt.some((x) => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x))))) hits += 1;
  }
  const precision = hits / q.length;
  const recall = hits / tt.length;
  if (!hits) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function findBestMatch(query, tasks, { threshold = 0.45 } = {}) {
  let best = null;
  let bestScore = 0;
  for (const task of tasks) {
    const s = scoreMatch(query, task.title);
    if (s > bestScore) { best = task; bestScore = s; }
  }
  return bestScore >= threshold ? { task: best, score: bestScore } : null;
}

// Exact offset for relative reminders: "in 30 seconds", "in a minute", "in 2 and a
// half hours", "in an hour and 20 minutes". Returns { ms, at } or null. Unlike a
// clock time, this keeps the seconds, so "in 1 minute" means 60 seconds from now.
export function relativeOffset(text, now = new Date()) {
  let t = numberWordsToDigits(normalize(text));
  t = t.replace(/\bin (?:about |around |roughly |like )?half an? (hour|minute)\b/, 'in 0.5 $1');
  t = t.replace(/\bin (\d+) and a half (hours?|minutes?)\b/, (m, n, u) => `in ${n}.5 ${u}`);
  const m = t.match(/\bin (?:about |around |roughly |like )?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)(?:\s+and\s+(?:(\d+)\s*(seconds?|secs?|minutes?|mins?)|(?:a\s+)?half))?\b/);
  if (!m) return null;
  const unitMs = (u) => (/^s/.test(u) ? 1000 : /^m/.test(u) ? 60000 : 3600000);
  let ms = parseFloat(m[1]) * unitMs(m[2]);
  if (m[3] && m[4]) ms += parseInt(m[3], 10) * unitMs(m[4]);
  else if (/\band\s+(?:a\s+)?half\b/.test(m[0])) ms += unitMs(m[2]) / 2;
  if (!(ms >= 5000) || ms > 366 * 86400000) return null;
  return { ms: Math.round(ms), at: new Date(now.getTime() + Math.round(ms)) };
}

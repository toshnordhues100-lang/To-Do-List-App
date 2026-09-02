// Thin wrapper around the browser SpeechRecognition and SpeechSynthesis APIs.
// Works in Chrome (Android, desktop), Edge, Safari (iOS 14.5+ / macOS) and Samsung Internet.

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

export const voiceSupported = Boolean(Recognition);
export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

export class VoiceInput {
  constructor({ lang = 'en-US', onInterim, onFinal, onStart, onEnd, onError } = {}) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onError = onError || (() => {});
    this.active = false;       // user wants us to be listening
    this.running = false;      // the engine is actually running
    this.continuous = false;
    this.rec = null;
    this.restartTimer = null;
    this.lastFinal = '';
    this.lastFinalAt = 0;
  }

  setLanguage(lang) {
    this.lang = lang;
    if (this.rec) this.rec.lang = lang;
  }

  _create() {
    const rec = new Recognition();
    rec.lang = this.lang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Continuous mode keeps the session open between phrases on Android/desktop Chrome.
    // iOS Safari ignores it, so we restart on `end` when the user still wants to listen.
    rec.continuous = this.continuous;

    rec.onstart = () => {
      this.running = true;
      this.onStart();
    };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const text = res[0].transcript;
        if (res.isFinal) {
          const clean = text.trim();
          // Some engines fire the same final result twice; drop exact repeats within 1.5s.
          if (clean && !(clean === this.lastFinal && Date.now() - this.lastFinalAt < 1500)) {
            this.lastFinal = clean;
            this.lastFinalAt = Date.now();
            this.onFinal(clean, res[0].confidence);
          }
        } else {
          interim += text;
        }
      }
      if (interim) this.onInterim(interim.trim());
    };
    rec.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine; surface the rest.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.onError(event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') {
        this.active = false;
      }
    };
    rec.onend = () => {
      this.running = false;
      if (this.active && this.continuous) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (this.active) this._start();
        }, 250);
      } else {
        this.active = false;
        this.onEnd();
      }
    };
    return rec;
  }

  _start() {
    if (!voiceSupported) return;
    try {
      this.rec = this._create();
      this.rec.start();
    } catch (e) {
      // start() throws if a session is already running; try again shortly.
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { if (this.active) this._start(); }, 400);
    }
  }

  start({ continuous = false } = {}) {
    if (!voiceSupported) {
      this.onError('unsupported');
      return;
    }
    this.continuous = continuous;
    this.active = true;
    if (!this.running) this._start();
  }

  // Temporarily pause (e.g. while the app is speaking) without leaving listening mode.
  pause() {
    if (this.rec && this.running) {
      const rec = this.rec;
      this.rec = null;
      rec.onend = () => { this.running = false; };
      try { rec.abort(); } catch { /* ignore */ }
      this.running = false;
    }
    clearTimeout(this.restartTimer);
  }

  resume() {
    if (this.active && !this.running) this._start();
  }

  stop() {
    this.active = false;
    clearTimeout(this.restartTimer);
    if (this.rec) {
      try { this.rec.stop(); } catch { /* ignore */ }
    } else {
      this.onEnd();
    }
  }

  toggle(opts) {
    if (this.active) this.stop();
    else this.start(opts);
  }
}

let preferredVoice = null;

function pickVoice(lang) {
  if (!speechSupported) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const base = lang.split('-')[0];
  const exact = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
  const same = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  const pool = exact.length ? exact : same.length ? same : voices;
  // Prefer higher quality local voices when the platform labels them.
  return pool.find((v) => /natural|premium|enhanced|siri|google/i.test(v.name)) || pool.find((v) => v.localService) || pool[0];
}

export function speak(text, { lang = 'en-US', onEnd } = {}) {
  if (!speechSupported || !text) {
    if (onEnd) onEnd();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1.02;
    u.pitch = 1;
    if (!preferredVoice || !preferredVoice.lang.toLowerCase().startsWith(lang.split('-')[0])) preferredVoice = pickVoice(lang);
    if (preferredVoice) u.voice = preferredVoice;
    u.onend = () => { if (onEnd) onEnd(); };
    u.onerror = () => { if (onEnd) onEnd(); };
    window.speechSynthesis.speak(u);
  } catch {
    if (onEnd) onEnd();
  }
}

export function stopSpeaking() {
  if (speechSupported) window.speechSynthesis.cancel();
}

if (speechSupported && typeof window.speechSynthesis.addEventListener === 'function') {
  window.speechSynthesis.addEventListener('voiceschanged', () => { preferredVoice = null; });
}

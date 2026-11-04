/**
 * The debug log: structured events from every part of the app, always recorded into an in-memory ring buffer, so
 * when something goes wrong the history is already there to copy (`debugLog.snapshot()`). Nothing leaves the page.
 *
 * Console output is opt-in per scope: `localStorage['gestalts:debug'] = 'repo,learn'` (or `*`), then reload.
 * Warnings and errors always reach the console.
 *
 * Spans time an operation; one still open after 2 s, 10 s and 30 s logs a "still running" warning, so a hang shows
 * up while it's happening, not only when (if) it ends. See doc/debugging.md.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogEvent = {
  /** Date.now() */
  t: number;
  scope: string;
  level: Level;
  msg: string;
  data?: Record<string, unknown>;
};

export type Span = {
  /** ends the span (logged at `debug`, or `warn` if it was slow) */
  end(data?: Record<string, unknown>): void;
  /** ends the span with an error */
  fail(err: unknown, data?: Record<string, unknown>): void;
};

export type Logger = {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  span(msg: string, data?: Record<string, unknown>): Span;
};

export const CAPACITY = 2000;
/** a span open this long (ms) is reported, and again at each following mark */
export const SLOW_MARKS = [2_000, 10_000, 30_000];
const MAX_STRING = 500;

type OpenSpan = { id: number; scope: string; msg: string; start: number; data?: Record<string, unknown>; reported: number };

const events: LogEvent[] = [];
let head = 0; // next slot once the buffer is full
const open = new Map<number, OpenSpan>();
let nextSpan = 1;
let watchdog: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<(e: LogEvent) => void>();
let consoleScopes: Set<string> | '*' | null | undefined;

function enabledScopes(): Set<string> | '*' | null {
  if (consoleScopes !== undefined) return consoleScopes;
  let v: string | null = null;
  try { v = globalThis.localStorage?.getItem('gestalts:debug') ?? null; } catch { /* no storage: console stays quiet */ }
  const parts = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  consoleScopes = parts.includes('*') ? '*' : parts.length ? new Set(parts) : null;
  return consoleScopes;
}

/** A value fit to keep: errors as plain objects, long strings cut, nested objects one level deep. */
function safe(v: unknown, depth = 0): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.slice(0, 2000) };
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (${v.length})` : v;
  if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? String(v) : v;
  if (v instanceof Date) return v.toISOString();
  if (depth >= 2) return Array.isArray(v) ? `[${v.length}]` : '{…}';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => safe(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, safe(x, depth + 1)]));
}

function record(scope: string, level: Level, msg: string, data?: Record<string, unknown>) {
  const e: LogEvent = { t: Date.now(), scope, level, msg, ...(data ? { data: safe(data) as Record<string, unknown> } : {}) };
  if (events.length < CAPACITY) events.push(e);
  else { events[head] = e; head = (head + 1) % CAPACITY; }
  const scopes = enabledScopes();
  if (level === 'warn' || level === 'error' || scopes === '*' || scopes?.has(scope)) {
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fn(`[${scope}] ${msg}`, ...(e.data ? [e.data] : []));
  }
  listeners.forEach((l) => { try { l(e); } catch { /* a listener never breaks logging */ } });
}

function checkOpen() {
  const now = Date.now();
  for (const s of open.values()) {
    const age = now - s.start;
    const mark = SLOW_MARKS[s.reported];
    if (mark !== undefined && age >= mark) {
      s.reported++;
      record(s.scope, 'warn', `${s.msg}: still running after ${Math.round(age / 1000)}s`, s.data);
    }
  }
  if (!open.size && watchdog !== undefined) { clearInterval(watchdog); watchdog = undefined; }
}

export function logger(scope: string): Logger {
  return {
    debug: (msg, data) => record(scope, 'debug', msg, data),
    info: (msg, data) => record(scope, 'info', msg, data),
    warn: (msg, data) => record(scope, 'warn', msg, data),
    error: (msg, data) => record(scope, 'error', msg, data),
    span(msg, data) {
      const s: OpenSpan = { id: nextSpan++, scope, msg, start: Date.now(), data, reported: 0 };
      open.set(s.id, s);
      watchdog ??= setInterval(checkOpen, 1000);
      record(scope, 'debug', `${msg}: start`, data);
      let done = false;
      const finish = (level: Level, suffix: string, extra?: Record<string, unknown>) => {
        if (done) return;
        done = true;
        open.delete(s.id);
        if (!open.size && watchdog !== undefined) { clearInterval(watchdog); watchdog = undefined; }
        const ms = Date.now() - s.start;
        record(scope, level === 'debug' && ms >= SLOW_MARKS[0] ? 'warn' : level, `${msg}: ${suffix}`, { ...data, ...extra, ms });
      };
      return {
        end: (extra) => finish('debug', 'end', extra),
        fail: (err, extra) => finish('error', 'failed', { ...extra, error: err }),
      };
    },
  };
}

export type DebugSnapshot = {
  at: string;
  userAgent: string;
  url: string;
  open: { scope: string; msg: string; ageMs: number; data?: Record<string, unknown> }[];
  events: LogEvent[];
};

export const debugLog = {
  /** every event kept, oldest first */
  events(): LogEvent[] {
    return events.length < CAPACITY ? [...events] : [...events.slice(head), ...events.slice(0, head)];
  },
  /** what to paste into a bug report */
  snapshot(): DebugSnapshot {
    const now = Date.now();
    return {
      at: new Date(now).toISOString(),
      userAgent: globalThis.navigator?.userAgent ?? '',
      url: globalThis.location?.href ?? '',
      open: [...open.values()].map((s) => ({ scope: s.scope, msg: s.msg, ageMs: now - s.start, ...(s.data ? { data: safe(s.data) as Record<string, unknown> } : {}) })),
      events: debugLog.events(),
    };
  },
  /** how many spans are open, and how many warnings and errors were kept */
  summary(): { open: number; warnings: number; errors: number } {
    let warnings = 0;
    let errors = 0;
    for (const e of events) { if (e.level === 'warn') warnings++; else if (e.level === 'error') errors++; }
    return { open: open.size, warnings, errors };
  },
  clear() {
    events.length = 0;
    head = 0;
  },
  /** re-reads the console scopes (after changing `gestalts:debug`) */
  reloadScopes() {
    consoleScopes = undefined;
  },
};

/** Called with each new event; returns the unsubscribe. */
export function onDebugLog(l: (e: LogEvent) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

let captured = false;

/** Logs uncaught errors and unhandled rejections (scope `global`). Safe to call more than once. */
export function installGlobalCapture() {
  if (captured || typeof window === 'undefined') return;
  captured = true;
  const log = logger('global');
  window.addEventListener('error', (e) => log.error('uncaught error', { message: e.message, source: e.filename, line: e.lineno, error: e.error }));
  window.addEventListener('unhandledrejection', (e) => log.error('unhandled rejection', { reason: e.reason }));
  log.info('page loaded', { url: location.href });
}

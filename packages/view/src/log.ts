/** Minimal console logging shared by the host and client packages. */

export type Span = {
  /** Reports only slow completions. */
  end(data?: Record<string, unknown>): void;
  /** Reports a failed operation. */
  fail(err: unknown, data?: Record<string, unknown>): void;
};

export type Logger = {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  span(msg: string, data?: Record<string, unknown>): Span;
};

export const SLOW_MS = 2_000;

function output(method: 'warn' | 'error', scope: string, msg: string, data?: Record<string, unknown>) {
  console[method](`[${scope}] ${msg}`, ...(data ? [data] : []));
}

export function logger(scope: string): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg, data) => output('warn', scope, msg, data),
    error: (msg, data) => output('error', scope, msg, data),
    span(msg, data) {
      const start = Date.now();
      let done = false;
      const finish = (failed: boolean, extra?: Record<string, unknown>, err?: unknown) => {
        if (done) return;
        done = true;
        const ms = Date.now() - start;
        const details = { ...data, ...extra, ...(failed ? { error: err } : {}), ms };
        if (failed) output('error', scope, `${msg}: failed`, details);
        else if (ms >= SLOW_MS) output('warn', scope, `${msg}: slow`, details);
      };
      return {
        end: (extra) => finish(false, extra),
        fail: (err, extra) => finish(true, extra, err),
      };
    },
  };
}

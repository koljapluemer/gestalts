/**
 * `next`, reusing every part of `prev` that is deeply equal to it (plain objects and arrays; anything else, such as a
 * function, by identity). Unchanged nodes keep their identity, so React Flow and the memoized cards skip them.
 */
export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out = next.map((v, i) => share(prev[i], v));
    return (out.length === prev.length && out.every((v, i) => v === prev[i]) ? prev : out) as T;
  }
  if (isPlain(prev) && isPlain(next)) {
    const keys = Object.keys(next);
    const out: Record<string, unknown> = {};
    let same = keys.length === Object.keys(prev).length;
    for (const k of keys) {
      out[k] = share(prev[k], next[k]);
      if (out[k] !== prev[k] || !(k in prev)) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

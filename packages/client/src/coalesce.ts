/**
 * Runs `run` at most once at a time, with at most one more run waiting. A trigger while a run is going asks for one
 * follow-up run (it may have missed what changed since that run started); triggers while a follow-up is already
 * waiting join it. Each trigger's promise is that of the run that covers it. A failed run doesn't block later ones.
 *
 * `onJoin` is told when a trigger joins a waiting follow-up, i.e. adds no run.
 */
export function coalesce<T>(run: () => Promise<T>, onJoin?: () => void): () => Promise<T> {
  let running: Promise<T> | null = null;
  let waiting: Promise<T> | null = null;

  const start = (): Promise<T> => {
    const p = (async () => run())();
    running = p;
    const done = () => { if (running === p) running = null; };
    p.then(done, done);
    return p;
  };

  return () => {
    if (!running) return start();
    if (waiting) {
      onJoin?.();
      return waiting;
    }
    const after = running.then(() => undefined, () => undefined);
    const w = after.then(() => {
      waiting = null;
      return start();
    });
    waiting = w;
    return w;
  };
}

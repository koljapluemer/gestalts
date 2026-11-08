import type { Answers, Call, FromView, ToView, ViewError } from './protocol';
import type { Delta } from './types';

/** What a view talks to: the app around it, or a fixture. */
export interface ViewHost {
  call<C extends Call>(call: C): Promise<Answers[C['op']]>;
  /** Calls `f` with each delta of the live query `sub`. */
  onDelta(sub: number, f: (d: Delta) => void): () => void;
  report(error: ViewError): void;
}

/** The host at the other end of `port`. */
export function connect(port: MessagePort): ViewHost {
  let nextId = 1;
  const waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  const listeners = new Map<number, (d: Delta) => void>();
  // a delta can arrive before `subscribe`'s reply has been handled
  const early = new Map<number, Delta[]>();
  const send = (m: FromView) => port.postMessage(m);
  port.onmessage = (e: MessageEvent<ToView>) => {
    const m = e.data;
    if (m.type === 'delta') {
      const l = listeners.get(m.delta.sub);
      if (l) l(m.delta);
      else early.set(m.delta.sub, [...(early.get(m.delta.sub) ?? []), m.delta]);
      return;
    }
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.ok) w?.resolve(m.value as never);
    else w?.reject(new Error(m.error));
  };
  return {
    call: <C extends Call>(call: C) => new Promise<Answers[C['op']]>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve: resolve as (v: never) => void, reject });
      send({ type: 'call', id, call });
    }),
    onDelta(sub, f) {
      listeners.set(sub, f);
      early.get(sub)?.forEach(f);
      early.delete(sub);
      return () => { listeners.delete(sub); };
    },
    report: (error) => send({ type: 'error', error }),
  };
}

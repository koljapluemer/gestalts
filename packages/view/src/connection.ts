import type { Answers, Call, FromView, ToView, ViewError } from './protocol';
import type { BeliefDelta, Delta } from './types';

/** What a view talks to: the app around it, or a fixture. */
export interface ViewHost {
  call<C extends Call>(call: C): Promise<Answers[C['op']]>;
  /** Calls `f` with each delta of the live query `sub`. */
  onDelta(sub: number, f: (d: Delta) => void): () => void;
  /** Calls `f` with each change to the belief subscription `sub`. */
  onBeliefs(sub: number, f: (d: BeliefDelta) => void): () => void;
  /** Calls `f` with the view's params each time the app moves it elsewhere. */
  onParams(f: (params: Record<string, string>) => void): () => void;
  report(error: ViewError): void;
}

/** The host at the other end of `port`. */
export function connect(port: MessagePort): ViewHost {
  let nextId = 1;
  const waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  const listeners = new Map<number, (d: Delta) => void>();
  // a delta can arrive before `subscribe`'s reply has been handled
  const early = new Map<number, Delta[]>();
  const beliefListeners = new Map<number, (d: BeliefDelta) => void>();
  const earlyBeliefs = new Map<number, BeliefDelta[]>();
  const moved = new Set<(params: Record<string, string>) => void>();
  // a move can arrive before anything listens (while the view mounts): the last one is handed over then
  let unheard: Record<string, string> | undefined;
  const send = (m: FromView) => port.postMessage(m);
  port.onmessage = (e: MessageEvent<ToView>) => {
    const m = e.data;
    if (m.type === 'delta') {
      const l = listeners.get(m.delta.sub);
      if (l) l(m.delta);
      else early.set(m.delta.sub, [...(early.get(m.delta.sub) ?? []), m.delta]);
      return;
    }
    if (m.type === 'beliefs') {
      const l = beliefListeners.get(m.delta.sub);
      if (l) l(m.delta);
      else earlyBeliefs.set(m.delta.sub, [...(earlyBeliefs.get(m.delta.sub) ?? []), m.delta]);
      return;
    }
    if (m.type === 'params') {
      if (moved.size) moved.forEach((f) => f(m.params));
      else unheard = m.params;
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
    onBeliefs(sub, f) {
      beliefListeners.set(sub, f);
      earlyBeliefs.get(sub)?.forEach(f);
      earlyBeliefs.delete(sub);
      return () => { beliefListeners.delete(sub); };
    },
    onParams(f) {
      moved.add(f);
      if (unheard) { f(unheard); unheard = undefined; }
      return () => { moved.delete(f); };
    },
    report: (error) => send({ type: 'error', error }),
  };
}

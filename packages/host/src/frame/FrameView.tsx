import { useEffect, useMemo, useRef, useState } from 'react';
import type { Repo } from '@gestalts/client';
import { PROTOCOL, logger, type FromView, type JsonMap, type ToView, type ViewError } from '@gestalts/view';
import type { FrameRuntime } from '../registry';
import { BOOT_HTML } from './boot';
import { Bridge, type Scope, type ViewEnv } from './bridge';

const log = logger('view');

/** A frame that hasn't mounted its view by now says how far it got. */
const STALLED_MS = 8000;

export type RunnableView = {
  id: string;
  title: string;
  js: string;
  npm: string[];
  scope: Scope;
  /** runs in the app's origin (granted by the distribution), so frames it embeds work like on any website */
  sameOrigin?: boolean;
};

const STRICT = 'allow-scripts allow-downloads';
const SAME_ORIGIN = 'allow-scripts allow-same-origin allow-downloads';
/** what a granted view's embeds (a video player) may use */
const SAME_ORIGIN_ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture';

type Props = {
  repo: Repo;
  view: RunnableView;
  runtime: FrameRuntime;
  /** the app's own stylesheet */
  css: string;
  /** Tailwind's browser build, for a view whose classes the app's build never saw */
  tailwind?: string;
  params: Record<string, string>;
  /** what it last saved */
  state: JsonMap;
  env: ViewEnv;
  onError?: (e: ViewError) => void;
  hidden?: boolean;
};

/** One view, in a sandboxed frame of its own. A new `view.js` gives a new frame. */
export function FrameView({ repo, view, runtime, css, tailwind, params, state, env, onError, hidden }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [failure, setFailure] = useState<string>();
  const latest = useRef({ env, onError });
  useEffect(() => { latest.current = { env, onError }; }, [env, onError]);
  const scopeKey = JSON.stringify(view.scope);
  const paramsKey = JSON.stringify(params);
  // what the view starts from is fixed when its frame is made
  const initial = useMemo(() => state, [view.id, view.js]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let port: MessagePort | undefined;
    let bridge: Bridge | undefined;
    let stage = 'frame created, not ready yet';
    const stalled = setTimeout(() => {
      log.warn('view has not started', { view: view.id, reached: stage });
      setFailure(`This view didn't start (reached: ${stage}).`);
    }, STALLED_MS);
    const envProxy: ViewEnv = {
      service: latest.current.env.service && ((...a) => latest.current.env.service!(...a)),
      net: latest.current.env.net && ((r) => latest.current.env.net!(r)),
      llm: latest.current.env.llm && ((r) => latest.current.env.llm!(r)),
      capabilities: latest.current.env.capabilities && (() => latest.current.env.capabilities!()),
      setState: (s) => latest.current.env.setState(s),
      setTitle: (t) => latest.current.env.setTitle(t),
      openView: (v, p) => latest.current.env.openView(v, p),
    };
    const onReady = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data !== 'gestalts:ready') return;
      stage = 'ready';
      log.debug('frame ready', { view: view.id });
      port?.close();
      bridge?.close();
      const channel = new MessageChannel();
      port = channel.port1;
      const post = (m: ToView) => port?.postMessage(m);
      const b = new Bridge(repo, JSON.parse(scopeKey) as Scope, envProxy, (delta) => post({ type: 'delta', delta }));
      bridge = b;
      port.onmessage = (m: MessageEvent<FromView>) => {
        const msg = m.data;
        if (msg.type === 'stage') {
          stage = msg.stage;
          log.debug('stage', { view: view.id, stage });
          if (stage === 'mounted') clearTimeout(stalled);
          return;
        }
        if (msg.type === 'error') {
          log.error('view error', { view: view.id, kind: msg.error.kind, message: msg.error.message, stack: msg.error.stack, reached: stage });
          // console.error from a view is its own business; these stop it working
          if (msg.error.kind !== 'console') setFailure(msg.error.message);
          latest.current.onError?.(msg.error);
          return;
        }
        b.handle(msg.call).then(
          (value) => post({ type: 'reply', id: msg.id, ok: true, value: value as object }),
          (err: unknown) => post({ type: 'reply', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      };
      frame.contentWindow?.postMessage({
        runtime: runtime.js, css: `${runtime.css}\n${css}`, tailwind, js: view.js, npm: view.npm,
        init: { protocol: PROTOCOL, id: view.id, title: view.title, params: JSON.parse(paramsKey) as Record<string, string>, state: initial },
      }, '*', [channel.port2]);
    };
    addEventListener('message', onReady);
    frame.srcdoc = BOOT_HTML;
    return () => {
      clearTimeout(stalled);
      setFailure(undefined);
      removeEventListener('message', onReady);
      bridge?.close();
      port?.close();
    };
  }, [repo, view.id, view.title, view.js, view.npm, view.sameOrigin, scopeKey, paramsKey, runtime, css, tailwind, initial]);

  return (
    <div className={`flex h-full w-full flex-col ${hidden ? 'hidden' : ''}`}>
      {failure && <div role="alert" className="alert alert-error rounded-none font-mono text-sm whitespace-pre-wrap">{view.title}: {failure}</div>}
      {/* sandbox flags apply when a frame loads, so a change of mode is a new frame */}
      <iframe key={view.sameOrigin ? 'same-origin' : 'strict'} ref={ref} title={view.title}
              sandbox={view.sameOrigin ? SAME_ORIGIN : STRICT} allow={view.sameOrigin ? SAME_ORIGIN_ALLOW : undefined} allowFullScreen={view.sameOrigin}
              className="block min-h-0 w-full flex-1 border-0 bg-base-100" />
    </div>
  );
}

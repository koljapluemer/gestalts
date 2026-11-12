import type { Live, Repo } from '@gestalts/client';
import { stableId, stateId } from '@gestalts/client';
import type { Answers, Call, Capabilities, Item, JsonMap, LlmReply, LlmRequest, NetReply, NetRequest, Query, ServiceReply, ToView } from '@gestalts/view';

/** What a view may touch: its `reads` and `writes`, the hosts it may reach, whether it may ask an LLM or record. */
export type Scope = { reads: string[]; writes: string[]; network?: string[]; llm?: boolean; microphone?: boolean };

/** What the bridge needs of the app, beyond the repo. */
export type ViewEnv = {
  /** this view's own backend; absent where there's none */
  service?: (path: string, method: string, body: string | Uint8Array | undefined, contentType: string | undefined) => Promise<ServiceReply>;
  /** HTTP through the node; absent where there's none */
  net?: (request: NetRequest) => Promise<NetReply>;
  /** completions through the node; absent where there's none */
  llm?: (request: LlmRequest) => Promise<LlmReply>;
  /** what `net`, `llm` and the backend can do right now (a node connected, a provider set up); `microphone` is the grant */
  capabilities?: () => Promise<Omit<Capabilities, 'microphone'>>;
  setState(state: JsonMap): void;
  setTitle(title: string): void;
  /** where the view put itself, kept so it comes back there */
  setParams(params: Record<string, string>): void;
  /** shows `view`; whether the app could */
  openView(view: string, params?: Record<string, string>): boolean;
};

/** Params are a flat map of strings, like a URL's query; anything else is refused before it's kept. */
function checkParams(params: unknown): Record<string, string> {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.values(params).every((v) => typeof v === 'string')) {
    throw new AccessError('params are a map of strings');
  }
  return params as Record<string, string>;
}

export class AccessError extends Error {}

export type BridgeRepo = Pick<Repo, 'query' | 'live' | 'liveBeliefs' | 'liveOutline' | 'get' | 'put' | 'delete' | 'readBlob' | 'writeBlob'>;

/** What the host sends a view unasked: changes to what it follows. */
export type Pushed = Extract<ToView, { type: 'delta' | 'beliefs' | 'outline' }>;

/** Sha256 in the page around the frame: a sandboxed frame isn't a secure context, so it has no `crypto.subtle`. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One running view's way in. Everything it asks is checked here, outside the frame it runs in, against what its
 * manifest declared. A query must name one gestalt the view reads, so nothing can be asked for wholesale.
 */
export class Bridge {
  private lives = new Map<number, Pick<Live, 'stop'>>();
  private nextSub = 1;

  constructor(private repo: BridgeRepo, private scope: Scope, private env: ViewEnv, private push: (m: Pushed) => void) {}

  private checkQuery(q: Query) {
    if (!q.gestalt) throw new AccessError('a query must name the gestalt it asks for');
    if (!this.scope.reads.includes(q.gestalt)) throw new AccessError(`this view doesn't declare that it reads ${q.gestalt}`);
  }

  private checkWrite(gestalt: string) {
    if (!this.scope.writes.includes(gestalt)) throw new AccessError(`this view doesn't declare that it writes ${gestalt}`);
  }

  /** The gestalt of what's at `id` now must be writable too, or a put could turn someone else's yml into one of ours. */
  private checkExisting(id: unknown) {
    const old: Item | undefined = typeof id === 'string' ? this.repo.get(id) : undefined;
    if (old) this.checkWrite(old.gestalt);
  }

  /** https to a host the manifest lists, nothing else: no other scheme, port or credentials. */
  private checkNet(r: NetRequest) {
    let url: URL;
    try { url = new URL(r.url); } catch { throw new AccessError(`not a URL: ${r.url}`); }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new AccessError(`only plain https URLs: ${r.url}`);
    if (!(this.scope.network ?? []).includes(url.hostname)) throw new AccessError(`this view doesn't declare that it reaches ${url.hostname}`);
  }

  async handle<C extends Call>(c: C): Promise<Answers[C['op']]> {
    return (await this.perform(c)) as Answers[C['op']];
  }

  private async perform(c: Call): Promise<unknown> {
    switch (c.op) {
      case 'query':
        this.checkQuery(c.query);
        return this.repo.query(c.query);
      case 'subscribe': {
        this.checkQuery(c.query);
        const sub = this.nextSub++;
        const live = this.repo.live(c.query, (d) => this.push({ type: 'delta', delta: { ...d, sub } }));
        this.lives.set(sub, live);
        return { sub, page: live.page };
      }
      case 'beliefs': {
        // beliefs say how well concepts are known, not what happened: reading concepts is enough
        if (!this.scope.reads.some((g) => g.startsWith('concept@'))) throw new AccessError('this view doesn\'t declare that it reads concept');
        if (!Array.isArray(c.concepts) || !c.concepts.every((x) => typeof x === 'string')) throw new AccessError('concepts are a list of ids');
        const sub = this.nextSub++;
        const live = this.repo.liveBeliefs(c.concepts, (d) => this.push({ type: 'beliefs', delta: { ...d, sub } }));
        this.lives.set(sub, live);
        return { sub, beliefs: live.beliefs };
      }
      case 'outline': {
        // an outline shows ymls of its gestalt (and their props), so that's what must be readable
        if (typeof c.query?.spec?.gestalt !== 'string') throw new AccessError('an outline must name the gestalt it is of');
        if (!this.scope.reads.includes(c.query.spec.gestalt)) throw new AccessError(`this view doesn't declare that it reads ${c.query.spec.gestalt}`);
        const sub = this.nextSub++;
        const live = this.repo.liveOutline(c.query, (d) => this.push({ type: 'outline', delta: { ...d, sub } }));
        this.lives.set(sub, live);
        return { sub, page: live.page };
      }
      case 'unsubscribe':
        this.lives.get(c.sub)?.stop();
        this.lives.delete(c.sub);
        return null;
      case 'put':
        this.checkWrite(String(c.value.gestalt));
        this.checkExisting(c.value.id);
        return this.repo.put(c.value);
      case 'delete': {
        const old = this.repo.get(c.id);
        if (!old) return false;
        this.checkWrite(old.gestalt);
        return this.repo.delete(c.id);
      }
      case 'readBlob':
        if (!this.scope.reads.length) throw new AccessError('this view reads nothing');
        return (await this.repo.readBlob(c.name)) ?? null;
      case 'writeBlob':
        if (!this.scope.writes.length) throw new AccessError('this view writes nothing');
        await this.repo.writeBlob(c.name, c.bytes);
        return null;
      case 'stableId': return stableId(c.namespace, c.name);
      case 'stateId': return stateId(c.gestalt, c.target, c.facet);
      case 'contentHash': return sha256(c.bytes);
      case 'service': {
        if (!this.env.service) throw new AccessError('this view has no backend here');
        return this.env.service(c.path, c.method, c.body, c.contentType);
      }
      case 'net':
        this.checkNet(c.request);
        if (!this.env.net) throw new AccessError('reaching the network needs the desktop app, which isn\'t connected here');
        return this.env.net(c.request);
      case 'llm':
        if (!this.scope.llm) throw new AccessError('this view doesn\'t declare that it asks an LLM');
        if (!this.env.llm) throw new AccessError('asking an LLM needs the desktop app, which isn\'t connected here');
        return this.env.llm(c.request);
      case 'capabilities': {
        const c_ = (await this.env.capabilities?.()) ?? { net: false, llm: false, backend: false };
        return { net: c_.net && !!this.scope.network?.length, llm: c_.llm && !!this.scope.llm, backend: c_.backend && !!this.env.service, microphone: !!this.scope.microphone };
      }
      case 'setState': this.env.setState(c.state); return null;
      case 'setTitle': this.env.setTitle(c.title); return null;
      case 'setParams': this.env.setParams(checkParams(c.params)); return null;
      case 'openView': return this.env.openView(c.view, c.params === undefined ? undefined : checkParams(c.params));
    }
  }

  /** The view is gone: nothing keeps listening for it. */
  close() {
    this.lives.forEach((l) => l.stop());
    this.lives.clear();
  }
}


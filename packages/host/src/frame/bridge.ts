import type { Live, Repo } from '@gestalts/client';
import { stableId, stateId } from '@gestalts/client';
import type { Answers, Call, Delta, Item, JsonMap, Query, ServiceReply } from '@gestalts/view';

/** What a view may touch: its `reads` and `writes`. */
export type Scope = { reads: string[]; writes: string[] };

/** What the bridge needs of the app, beyond the repo. */
export type ViewEnv = {
  /** this view's own backend; absent where there's none */
  service?: (path: string, method: string, body: string | Uint8Array | undefined, contentType: string | undefined) => Promise<ServiceReply>;
  setState(state: JsonMap): void;
  setTitle(title: string): void;
  openView(view: string, params?: Record<string, string>): void;
};

export class AccessError extends Error {}

export type BridgeRepo = Pick<Repo, 'query' | 'live' | 'get' | 'put' | 'delete' | 'readBlob' | 'writeBlob'>;

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
  private lives = new Map<number, Live>();
  private nextSub = 1;

  constructor(private repo: BridgeRepo, private scope: Scope, private env: ViewEnv, private onDelta: (d: Delta) => void) {}

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
        const live = this.repo.live(c.query, (d) => this.onDelta({ ...d, sub }));
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
      case 'setState': this.env.setState(c.state); return null;
      case 'setTitle': this.env.setTitle(c.title); return null;
      case 'openView': this.env.openView(c.view, c.params); return null;
    }
  }

  /** The view is gone: nothing keeps listening for it. */
  close() {
    this.lives.forEach((l) => l.stop());
    this.lives.clear();
  }
}


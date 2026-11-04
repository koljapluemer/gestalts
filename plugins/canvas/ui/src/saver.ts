import type { WireNode } from './model';

/**
 * `saved`: nothing to write; `pending`: changes wait; `saving`: a write is under way (newer changes wait for it);
 * `error`: the last write failed, its changes are kept for the next one.
 */
export type SaveState = { status: 'saved' | 'pending' | 'saving' | 'error'; error: string | null };

/**
 * Writes one canvas, a whole snapshot at a time: `delay` after the last change, at most one write under way, the
 * changes made meanwhile together in the next. Held while a node is dragged, flushed when the page is hidden.
 */
export class CanvasSaver {
  private unsaved: WireNode[] | null = null;
  private inFlight: Promise<void> | null = null;
  private held = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: SaveState = { status: 'saved', error: null };
  private readonly listeners = new Set<() => void>();

  /** the snapshot last handed to `write` (at first: the canvas as stored), to tell own writes from changes made elsewhere */
  written: WireNode[];

  constructor(private readonly write: (nodes: WireNode[]) => Promise<void>, stored: WireNode[] = [], private readonly delay = 400) {
    this.written = stored;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get = () => this.state;

  /** Whether nothing is waiting or being written. */
  get idle() {
    return this.unsaved === null && this.inFlight === null;
  }

  change(nodes: WireNode[]) {
    this.unsaved = nodes;
    if (this.state.status !== 'saving') this.set({ status: 'pending', error: this.state.error });
    this.schedule();
  }

  hold(on: boolean) {
    this.held = on;
    if (!on) this.schedule();
  }

  /** Writes what's waiting now; resolves once nothing is under way. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    for (;;) {
      if (this.inFlight) {
        await this.inFlight;
        // a failed write keeps its changes for a retry; don't spin on it
        if (this.state.status === 'error') return;
      } else if (this.unsaved) this.start();
      else return;
    }
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.held && this.unsaved) this.timer = setTimeout(() => this.start(), this.delay);
  }

  private start() {
    if (this.inFlight || !this.unsaved) return;
    const nodes = this.unsaved;
    this.unsaved = null;
    this.written = nodes;
    this.set({ status: 'saving', error: null });
    this.inFlight = this.write(nodes).then(
      () => {
        this.inFlight = null;
        if (this.unsaved) { this.set({ status: 'pending', error: null }); this.schedule(); }
        else this.set({ status: 'saved', error: null });
      },
      (e: unknown) => {
        this.inFlight = null;
        this.unsaved ??= nodes;
        this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  /** After an error: try again now. */
  retry() {
    this.start();
  }

  private set(state: SaveState) {
    this.state = state;
    this.listeners.forEach((l) => l());
  }
}

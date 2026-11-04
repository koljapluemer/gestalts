import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasSaver } from './saver';
import type { WireNode } from './model';

const n = (id: string): WireNode[] => [{ id, x: 0, y: 0, text: id }];

describe('CanvasSaver', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes the last snapshot after a pause, one write at a time', async () => {
    const writes: WireNode[][] = [];
    let release!: () => void;
    const saver = new CanvasSaver((nodes) => { writes.push(nodes); return new Promise((r) => { release = r; }); }, [], 100);
    saver.change(n('a'));
    saver.change(n('b'));
    expect(saver.get().status).toBe('pending');
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toEqual([n('b')]);
    saver.change(n('c'));
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toEqual([n('b'), n('c')]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.get().status).toBe('saved');
    expect(saver.idle).toBe(true);
  });

  it('holds while dragging and keeps changes of a failed write', async () => {
    let fail = true;
    const writes: WireNode[][] = [];
    const saver = new CanvasSaver(async (nodes) => { writes.push(nodes); if (fail) throw new Error('disk full'); }, [], 100);
    saver.hold(true);
    saver.change(n('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(0);
    saver.hold(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(saver.get()).toEqual({ status: 'error', error: 'disk full' });
    fail = false;
    saver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([n('a'), n('a')]);
    expect(saver.get().status).toBe('saved');
  });

  it('flushes at once', async () => {
    const writes: WireNode[][] = [];
    const saver = new CanvasSaver(async (nodes) => { writes.push(nodes); }, [], 10_000);
    saver.change(n('a'));
    await saver.flush();
    expect(writes).toEqual([n('a')]);
  });
});

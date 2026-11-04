import { describe, expect, it } from 'vitest';
import { coalesce } from './coalesce';

/** a run whose end the test controls */
function controlled() {
  const runs: { resolve: (v: number) => void; reject: (e: unknown) => void }[] = [];
  const run = () => new Promise<number>((resolve, reject) => { runs.push({ resolve, reject }); });
  return { run, runs };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('coalesce', () => {
  it('runs once for one trigger', async () => {
    const { run, runs } = controlled();
    const sync = coalesce(run);
    const p = sync();
    expect(runs).toHaveLength(1);
    runs[0].resolve(1);
    expect(await p).toBe(1);
  });

  it('folds triggers during a run into one follow-up', async () => {
    const { run, runs } = controlled();
    let joined = 0;
    const sync = coalesce(run, () => joined++);
    const first = sync();
    const a = sync();
    const b = sync();
    const c = sync();
    expect(runs).toHaveLength(1);
    expect(joined).toBe(2);
    runs[0].resolve(1);
    expect(await first).toBe(1);
    await tick();
    expect(runs).toHaveLength(2);
    runs[1].resolve(2);
    // every trigger during the first run is covered by the follow-up, which started after it
    expect(await Promise.all([a, b, c])).toEqual([2, 2, 2]);
    await tick();
    expect(runs).toHaveLength(2);
  });

  it('starts again after a failed run', async () => {
    const { run, runs } = controlled();
    const sync = coalesce(run);
    const first = sync();
    const next = sync();
    runs[0].reject(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    await tick();
    expect(runs).toHaveLength(2);
    runs[1].resolve(2);
    expect(await next).toBe(2);
    const later = sync();
    expect(runs).toHaveLength(3);
    runs[2].resolve(3);
    expect(await later).toBe(3);
  });
});

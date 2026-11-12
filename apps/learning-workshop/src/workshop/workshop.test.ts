import { describe, expect, it, vi } from 'vitest';

vi.mock('@gestalts/client', () => ({ stableId: () => 'abcdefgh-ijkl' }));
const { applyFiles, createView, filesOf } = await import('./workshop');

const view = { id: 'v', title: 'T', source: 'a', reads: ['note@1'], writes: [] };

describe('a view as files', () => {
  it('round-trips through what the agent sees', () => {
    expect(applyFiles(view, filesOf(view))).toEqual(view);
  });

  it('takes changed source and scope, and ignores a broken view.json', () => {
    expect(applyFiles(view, { 'view.tsx': 'b' }).source).toBe('b');
    expect(applyFiles(view, { 'view.json': JSON.stringify({ title: 'N', reads: [], writes: [] }) })).toMatchObject({ title: 'N', reads: [] });
    expect(applyFiles(view, { 'view.json': '{nope' })).toEqual(view);
    expect(applyFiles(view, { 'view.tsx': null })).toEqual(view);
  });

  it('gets an id from its title that can be a file name', async () => {
    const put = vi.fn(async () => ({}));
    const id = await createView({ put } as never, 'Märchen & Co!');
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Item } from '@gestalts/view';
import { applyFiles, asDraft, createDraft, definitionId, filesOf, packageOf, saveDraft, type Draft } from './draft';

const draft: Draft = { id: 'v', title: 'T', source: 'a', reads: ['note@1'], writes: [], npm: {}, package: 'd-abc', members: [] };
const noun: Item = { id: 'gestalt-d-abc.noun.1', gestalt: 'gestalt@1', value: { id: 'gestalt-d-abc.noun.1', gestalt: 'gestalt@1', name: 'd-abc/noun', version: 1, fields: { word: { type: 'string', required: true } } } };
const haus: Item = { id: 'haus', gestalt: 'd-abc/noun@1', value: { id: 'haus', gestalt: 'd-abc/noun@1', word: 'Haus' } };
const withMembers = { ...draft, members: [noun.id, haus.id] };

describe('a draft as files', () => {
  it('round-trips through what the agent sees, changing nothing', () => {
    const files = filesOf(withMembers, [noun, haus]);
    expect(Object.keys(files).sort()).toEqual(['data/haus.yml', 'gestalts/noun@1.yml', 'view.json', 'view.tsx']);
    expect(files['gestalts/noun@1.yml']).not.toContain('name');
    const c = applyFiles(withMembers, [noun, haus], files);
    expect(c).toMatchObject({ draft: withMembers, put: [], remove: [], added: [], problems: [] });
  });

  it('turns new files into ymls, definitions first, named in the draft package', () => {
    const c = applyFiles(draft, [], {
      'data/baum.yml': 'gestalt: d-abc/noun@1\nword: Baum\n',
      'gestalts/noun@1.yml': 'fields:\n  word: { type: string }\n',
    });
    expect(c.put.map((v) => v.id)).toEqual(['gestalt-d-abc.noun.1', 'baum']);
    expect(c.put[0]).toMatchObject({ gestalt: 'gestalt@1', name: 'd-abc/noun', version: 1 });
    expect(c.draft.members).toEqual(['gestalt-d-abc.noun.1', 'baum']);
    expect(c.added).toEqual(c.draft.members);
  });

  it('removes deleted members and keeps a member whose file broke', () => {
    const c = applyFiles(withMembers, [noun, haus], { 'data/haus.yml': null, 'gestalts/noun@1.yml': 'fields: [' });
    expect(c.remove).toEqual(['haus']);
    expect(c.draft.members).toEqual([noun.id]);
    expect(c.put).toEqual([]);
    expect(c.problems).toHaveLength(1);
  });

  it('takes source and scope, ignores a broken view.json and anything outside the draft', () => {
    expect(applyFiles(draft, [], { 'view.tsx': 'b' }).draft.source).toBe('b');
    const scoped = applyFiles(draft, [], { 'view.json': JSON.stringify({ title: 'N', reads: ['d-abc/noun@1'], writes: [], npm: { three: '0.170.0' }, package: 'stolen' }) });
    expect(scoped.draft).toMatchObject({ title: 'N', reads: ['d-abc/noun@1'], npm: { three: '0.170.0' }, package: 'd-abc' });
    const broken = applyFiles(draft, [], { 'view.json': '{nope', 'notes.md': 'x' });
    expect(broken.draft).toEqual(draft);
    expect(broken.problems).toHaveLength(2);
  });

  it('reads a view@1 as a draft without members, in a package of its own', () => {
    const d = asDraft({ id: 'old', gestalt: 'view@1', value: { id: 'old', gestalt: 'view@1', title: 'T', source: 's', reads: [], writes: [] } });
    expect(d).toMatchObject({ members: [], npm: {}, package: packageOf('old') });
    expect(d.package).toMatch(/^d-[0-9a-f]{12}$/);
    expect(packageOf('old')).not.toBe(packageOf('new'));
  });

  it('names definitions as the core does', () => {
    expect(definitionId('d-abc', 'noun', 2)).toBe('gestalt-d-abc.noun.2');
  });
});

describe('saving', () => {
  it('writes in order, and leaves a refused new yml out of the members', async () => {
    const written: string[] = [];
    const repo = {
      put: vi.fn(async (v: Record<string, unknown>) => { if (v.id === 'bad') throw new Error('word is required'); written.push(String(v.id)); return {} as never; }),
      delete: vi.fn(async () => true),
    };
    const c = applyFiles(withMembers, [noun, haus], { 'data/haus.yml': null, 'data/bad.yml': 'gestalt: d-abc/noun@1\n' });
    const { draft: saved, problems } = await saveDraft(repo, c, 'rt1');
    expect(written).toEqual(['v']);
    expect(repo.delete).toHaveBeenCalledWith('haus');
    expect(saved).toMatchObject({ members: [noun.id], runtime: 'rt1' });
    expect(problems[0]).toContain('word is required');
  });

  it('makes a draft whose id can be a file name', async () => {
    const put = vi.fn(async () => ({}) as never);
    const id = await createDraft({ put }, 'Märchen & Co!', 'rt');
    expect(id).toMatch(/^marchen-co-[0-9a-f]{8}$/);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ gestalt: 'view@2', package: packageOf(id), runtime: 'rt' }));
  });
});

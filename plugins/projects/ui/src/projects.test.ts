import { describe, expect, it } from 'vitest';
import type { IndexedNote, Json } from '@gestalts/sdk';
import { group, issueSeed, THINK_TAG } from './projects';

const note = (key: string, value: Record<string, Json>): IndexedNote =>
  ({ key, id: key, raw: '', value, parse_error: null, gestalts: [], lints: [] });
const project = (key: string, title: string) => note(key, { title, tags: ['project'] });
const issue = (key: string, title: string, to: string[] = [], extraTags: string[] = []) =>
  note(key, { title, tags: ['issue', ...extraTags], relationships: to.map((t) => ({ to: t, label: 'project' })) });
const keys = (ns: IndexedNote[]) => ns.map((n) => n.key);

describe('group', () => {
  it('puts issues under the projects they point to, by label', () => {
    const got = group([project('p2', 'beta'), project('p1', 'Alpha')], [issue('i1', 'one', ['p1']), issue('i2', 'two', ['p2'])]);
    expect(got.projects.map((g) => [g.project.key, keys(g.issues)])).toEqual([['p1', ['i1']], ['p2', ['i2']]]);
    expect(got.orphans).toEqual([]);
  });

  it('lists an issue in several projects under each', () => {
    const got = group([project('p1', 'a'), project('p2', 'b')], [issue('i', 'x', ['p1', 'p2', 'p1'])]);
    expect(got.projects.map((g) => keys(g.issues))).toEqual([['i'], ['i']]);
  });

  it('keeps issues without a project apart', () => {
    const other = note('n', { title: 'not a project' });
    const unlabelled = note('u', { title: 'u', tags: ['issue'], relationships: ['p1'] });
    const got = group([project('p1', 'a')], [issue('i1', 'none'), issue('i2', 'to a note', [other.key]), unlabelled]);
    expect(got.projects[0].issues).toEqual([]);
    expect(keys(got.orphans)).toEqual(['i1', 'i2', 'u']);
  });

  it('lists issues to think about first, then by label', () => {
    const got = group([project('p', 'p')], [
      issue('a', 'a', ['p']), issue('c', 'c', ['p'], [THINK_TAG]), issue('B', 'B', ['p']), issue('d', 'd', ['p'], [THINK_TAG]),
    ]);
    expect(keys(got.projects[0].issues)).toEqual(['c', 'd', 'a', 'B']);
  });

  it('matches relationships by id, not key', () => {
    const p = { ...project('file-name', 'p'), id: 'uuid-1' };
    expect(keys(group([p], [issue('i', 'i', ['uuid-1'])]).projects[0].issues)).toEqual(['i']);
  });
});

describe('issueSeed', () => {
  it('relates the new issue to the project', () => {
    expect(issueSeed({ ...project('k', 'p'), id: 'uuid' }).value).toEqual({ relationships: [{ to: 'uuid', label: 'project' }] });
  });
});

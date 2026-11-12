import { describe, expect, it } from 'vitest';
import { fixtureHost } from './fixture';
import type { JsonMap, OutlineAsk, OutlineSpec } from './types';

const spec: OutlineSpec = { gestalt: 'note@1', field: 'relationships', follows: 'follows', branches: 'branches from', rootTag: 'zettelkasten-root', excludeTag: 'no-zettelkasten' };
const note = (id: string, rest: JsonMap = {}): JsonMap => ({ id, gestalt: 'note@1', ...rest });
const at = (label: string, to: string) => ({ relationships: [{ to, label }] });

// the same cases as the core's tests, so the fixture says what the app would
describe('the fixture outline', () => {
  const ask = async (ymls: JsonMap[], a: OutlineAsk) => {
    const { page } = await fixtureHost(ymls).call({ op: 'outline', query: { spec, ask: a } });
    return page.entries.map((e) => [e.item.id, e.status, e.marks.map((m) => m.kind)]);
  };

  it('lists sequences depth first and branches under their note', async () => {
    const ymls = [note('a1', { tags: ['zettelkasten-root'] }), note('a2', at('follows', 'a1')), note('b1', at('branches from', 'a1')), note('b2', at('follows', 'b1')), note('x', at('follows', 'a1')), note('x2', at('follows', 'x'))];
    expect((await ask(ymls, { children: null })).map((r) => r[0])).toEqual(['a1', 'a2', 'x', 'x2']);
    expect((await ask(ymls, { children: 'a1' })).map((r) => r[0])).toEqual(['b1', 'b2']);
    const { page } = await fixtureHost(ymls).call({ op: 'outline', query: { spec, ask: { locate: ['b2'] } } });
    expect(page.entries[0].path?.map((i) => i.id)).toEqual(['a1']);
  });

  it('says why what floats floats', async () => {
    const ymls = [
      note('r', { tags: ['zettelkasten-root'] }),
      note('gone1', at('follows', 'nowhere')),
      note('gone2', at('follows', 'gone1')),
      note('on-u', at('branches from', 'u')),
      note('u'),
      note('on-x', at('follows', 'x')),
      note('x', { tags: ['no-zettelkasten'] }),
      note('c1', at('follows', 'c2')),
      note('c2', at('follows', 'c1')),
      note('r2', { tags: ['zettelkasten-root'] }),
      note('on-r2', at('follows', 'r2')),
      note('twice', { relationships: [{ to: 'r', label: 'follows' }, { to: 'u', label: 'branches from' }] }),
      note('ex-placed', { tags: ['no-zettelkasten'], ...at('follows', 'twice') }),
    ];
    expect(await ask(ymls, 'loose')).toEqual([
      ['c1', 'floating', ['cycle']],
      ['ex-placed', 'attached', ['excludedPlaced']],
      ['gone1', 'floating', ['parentMissing']],
      ['on-u', 'floating', ['parentUnplaced']],
      ['on-x', 'floating', ['parentExcluded']],
      ['r2', 'floating', ['extraRoot']],
      ['twice', 'attached', ['placedTwice']],
    ]);
  });

  it('finds what isn\'t placed with links', async () => {
    const host = fixtureHost([note('r', { tags: ['zettelkasten-root'] }), note('a', at('follows', 'r')), note('b', at('see', 'r')), note('c', at('follows', 'nowhere'))]);
    const none = [{ label: 'follows' }, { label: 'branches from' }];
    const page = await host.call({ op: 'query', query: { gestalt: 'note@1', links: { none }, tags: { none: ['zettelkasten-root'] } } });
    expect(page.items.map((i) => i.id)).toEqual(['b']);
    const toRoot = await host.call({ op: 'query', query: { gestalt: 'note@1', links: { all: [{ label: 'follows', to: { tags: { all: ['zettelkasten-root'] } } }] } } });
    expect(toRoot.items.map((i) => i.id)).toEqual(['a']);
  });
});

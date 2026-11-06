import { defineLens } from '@gestalts/sdk';
import { forgetPractice } from './quote';

const words = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A quote: who said it; changing its words starts its practice over. */
export const QuoteLens = defineLens({
  gestalt: 'quote@1',
  title: 'Quote',
  fields: { attribution: { label: 'who said it' } },
  // read: the words quoted, who said them below
  gist: {
    keys: ['main', 'attribution'],
    blocks: (n) => {
      const quote = words(n.main);
      const by = words(n.attribution);
      return quote ? [{ kind: 'quote', markdown: `${quote.split('\n').map((l) => `> ${l}`).join('\n')}${by ? `\n\n— ${by}` : ''}` }] : [];
    },
  },
  afterSave: async (repo, { before, after }) => {
    if (before && words(before.main) !== words(after.main) && typeof after.id === 'string') await forgetPractice(repo, after.id);
  },
});

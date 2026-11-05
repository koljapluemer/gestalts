import { defineLens } from '@gestalts/sdk';
import { forgetPractice } from './quote';

const words = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A quote: who said it; changing its words starts its practice over. */
export const QuoteLens = defineLens({
  gestalt: 'quote@1',
  title: 'Quote',
  fields: { attribution: { label: 'who said it' } },
  afterSave: async (repo, { before, after }) => {
    if (before && words(before.main) !== words(after.main) && typeof after.id === 'string') await forgetPractice(repo, after.id);
  },
});

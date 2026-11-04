import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { inCodeOrMath, referenceAt } from './markdownCompletion';

const state = (doc: string) => {
  const s = EditorState.create({ doc, extensions: [markdown()] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
};

describe('markdown completion', () => {
  it('is off inside code and math', () => {
    const doc = 'a [[ `b [[` $c [[ d$\n\n```\n[[\n```\n';
    const s = state(doc);
    const at = (needle: string, nth = 0) => {
      let i = -1;
      for (let k = 0; k <= nth; k++) i = doc.indexOf(needle, i + 1);
      return i + needle.length;
    };
    expect(inCodeOrMath(s, at('[['))).toBe(false);
    expect(inCodeOrMath(s, at('[[', 1))).toBe(true);
    expect(inCodeOrMath(s, at('[[', 2))).toBe(true);
    expect(inCodeOrMath(s, at('[[', 3))).toBe(true);
  });

  it('finds the reference under the cursor, not embeds', () => {
    const s = state('see [[abc|A]] and ![[x.png]]');
    expect(referenceAt(s, 7)).toEqual({ from: 4, to: 13, target: 'abc' });
    expect(referenceAt(s, 22)).toBeNull();
    expect(referenceAt(s, 15)).toBeNull();
  });
});

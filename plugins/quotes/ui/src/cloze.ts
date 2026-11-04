/** The mark shown where words are hidden. */
export const CLOZE_MARK = '＿';

export function splitWords(content: string): string[] {
  return content.trim().split(/\s+/).filter((w) => w.length > 0);
}

/** A quote has one level per word: level `n` hides its last `n` words. */
export function levelCount(content: string): number {
  return splitWords(content).length;
}

export function clozeParts(content: string, level: number): { visible: string; hidden: string } {
  const words = splitWords(content);
  const shown = Math.max(words.length - level, 0);
  return { visible: words.slice(0, shown).join(' '), hidden: words.slice(shown).join(' ') };
}

export function clozeFront(content: string, level: number): string {
  const { visible } = clozeParts(content, level);
  return visible ? `${visible} ${CLOZE_MARK}` : CLOZE_MARK;
}

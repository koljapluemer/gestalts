/** Lowercase without diacritics, so `δελφις` finds `δελφίς` and `cafe` finds `Café`. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Folded words (letters and digits). */
export function words(s: string): string[] {
  return foldText(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

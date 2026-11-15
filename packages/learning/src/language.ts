// only the 639-1 map (184 codes): the package's index also pulls in every 639-3 language (780 KB)
import { iso6393To1 } from 'iso-639-3/iso6393-to-1.js';

const TO_639_3 = new Map(Object.entries(iso6393To1).map(([three, two]) => [two, three]));

/**
 * The ISO 639-3 code of a language tag's language, as concept names carry it (`vie:xin chào`): `vi` → `vie`,
 * `pt-BR` → `por`, YouTube's old `iw` → `heb`, `fil` as it is. `Intl` can't do this: it canonicalises to the
 * shortest code. A tag that isn't well-formed gives its first subtag, lowercased.
 */
export function iso639_3(tag: string): string {
  let language = tag.trim().split(/[-_]/)[0].toLowerCase();
  try { language = new Intl.Locale(Intl.getCanonicalLocales(tag.trim())[0]).language; } catch { /* as given */ }
  return TO_639_3.get(language) ?? language;
}

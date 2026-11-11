/**
 * The source model: the subset of biblatex needed to cite in ACM, IEEE or APA style, plus a canonical url. These are
 * the props of `source@1` that BibTeX knows about (`key`, `entrytype`, `title` and {@link FIELDS}); `aliases`, `tags`,
 * `extra` and `blobs` are the yml's own.
 *
 * Field types:
 * - `literal`: a string
 * - `integer`
 * - `range`: a string, e.g. `12--34`
 * - `name`: a list of names, each `family, given`, `family, suffix, given`, or without a comma one name that is never
 *   split (an organisation); leading lowercase words of the family part are its prefix (`van`)
 * - `list`: a list of strings
 * - `date`: `2020`, `2020-05`, `2020-05-17`, or a range of them (`2020/2021`)
 * - `uri`, `verbatim`: strings kept exactly
 */

export type FieldType = 'literal' | 'integer' | 'range' | 'name' | 'list' | 'date' | 'uri' | 'verbatim';

/** In display order: the order of the form and of the .bib. */
export const FIELDS = {
  author: 'name',
  editor: 'name',
  date: 'date',
  urldate: 'date',
  journaltitle: 'literal',
  booktitle: 'literal',
  series: 'literal',
  type: 'literal',
  number: 'literal',
  volume: 'integer',
  edition: 'literal',
  version: 'literal',
  pages: 'range',
  publisher: 'list',
  institution: 'list',
  organization: 'list',
  location: 'list',
  doi: 'verbatim',
  isbn: 'verbatim',
  eprint: 'verbatim',
  eprinttype: 'literal',
  url: 'uri',
} as const satisfies Record<string, FieldType>;

export type FieldName = keyof typeof FIELDS;
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

const ARTICLE: FieldName[] = ['author', 'journaltitle', 'date', 'volume', 'number', 'pages', 'doi', 'url', 'urldate'];
const BOOK: FieldName[] = ['author', 'date', 'edition', 'volume', 'series', 'publisher', 'location', 'isbn', 'doi', 'url'];
const IN: FieldName[] = ['author', 'booktitle', 'editor', 'date', 'publisher', 'location', 'pages', 'doi', 'url'];

/** The entry types, each with the fields shown by default; any other field is added on demand. */
export const ENTRY_TYPES = {
  article: ARTICLE,
  book: BOOK,
  incollection: IN,
  inproceedings: IN,
  thesis: ['author', 'type', 'institution', 'date', 'location', 'doi', 'url', 'urldate'],
  report: ['author', 'type', 'number', 'institution', 'date', 'location', 'url', 'urldate'],
  online: ['author', 'date', 'organization', 'url', 'urldate'],
  software: ['author', 'date', 'version', 'publisher', 'doi', 'url', 'urldate'],
  misc: ['author', 'date', 'type', 'url', 'urldate'],
} as const satisfies Record<string, FieldName[]>;

export type EntryType = keyof typeof ENTRY_TYPES;
export const isEntryType = (t: unknown): t is EntryType => typeof t === 'string' && Object.hasOwn(ENTRY_TYPES, t);

export type FieldValue = string | number | string[];

/** A source's bibliographic part. */
export type Bib = { key: string; entrytype: EntryType; title?: string } & { [F in FieldName]?: FieldValue };

export const DATE_RE = /^(?=.)(?:-?\d{4}(?:-\d{2}(?:-\d{2})?)?)?(?:\/(?:-?\d{4}(?:-\d{2}(?:-\d{2})?)?)?)?$/;
export const KEY_RE = /^[A-Za-z0-9_:.\-/+]+$/;

export class ValidationError extends Error {}

export type NameParts = { literal: string } | { family: string; given: string; prefix?: string; suffix?: string };

/** A name's parts: `{literal}` without a comma, else family and given (and prefix, suffix). Throws ValidationError. */
export function splitName(name: string): NameParts {
  const parts = name.split(',').map((p) => p.trim());
  if (parts.length === 1) return { literal: parts[0] };
  if (parts.length > 3 || parts.some((p) => !p)) {
    throw new ValidationError(`invalid name '${name}': expected 'family, given' or 'family, suffix, given'`);
  }
  const words = parts[0].split(/\s+/);
  let n = 0;
  while (n < words.length - 1 && isLower(words[n])) n++;
  return {
    family: words.slice(n).join(' '),
    given: parts.at(-1)!,
    ...(n ? { prefix: words.slice(0, n).join(' ') } : {}),
    ...(parts.length === 3 ? { suffix: parts[1] } : {}),
  };
}

const isLower = (word: string) => { const c = word.charAt(0); return c !== c.toUpperCase() && c === c.toLowerCase(); };

/** The name string for its parts (all optional); without a given name (or family), the rest as one name. */
export function joinName(parts: { family?: string; given?: string; prefix?: string; suffix?: string }): string {
  const family = [parts.prefix, parts.family].filter(Boolean).join(' ');
  const given = parts.given ?? '';
  if (!family || !given) return family || given;
  return (parts.suffix ? [family, parts.suffix, given] : [family, given]).join(', ');
}

/** ISBN-13 digits; an ISBN-10 is converted. Empty when it isn't one. */
export function isbn13(v: unknown): string {
  let s = String(v ?? '').toUpperCase().replace(/[^0-9X]/g, '');
  if (s.length === 10) {
    s = '978' + s.slice(0, 9);
    s += String((10 - ([...s].reduce((sum, d, i) => sum + Number(d) * (i % 2 === 0 ? 1 : 3), 0) % 10)) % 10);
  }
  return /^\d{13}$/.test(s) ? s : '';
}

/** A DOI as kept: lowercase, without a resolver or `doi:` prefix. */
export function bareDoi(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/^(https?:\/\/)?(dx\.)?doi\.org\/|^doi:\s*/, '').trim();
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw new ValidationError(`${field}: expected text`);
  return v.trim();
};

function clean(name: FieldName, value: unknown): FieldValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const type: FieldType = FIELDS[name];
  switch (type) {
    case 'integer': {
      const s = typeof value === 'number' ? String(value) : str(value, name);
      if (!s) return undefined;
      if (!/^-?\d+$/.test(s)) throw new ValidationError(`${name}: expected a whole number`);
      return Number(s);
    }
    case 'name': {
      const list = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(list)) throw new ValidationError(`${name}: expected a list of names`);
      const names = list.map((v) => str(v, name).split(/\s+/).join(' ')).filter(Boolean);
      names.forEach(splitName);
      return names.length ? names : undefined;
    }
    case 'list': {
      const list = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(list)) throw new ValidationError(`${name}: expected a list`);
      const items = list.map((v) => str(v, name)).filter(Boolean);
      return items.length ? items : undefined;
    }
    default: {
      const s = str(value, name);
      if (!s) return undefined;
      if (type === 'date' && !DATE_RE.test(s)) throw new ValidationError(`${name}: invalid date '${s}'`);
      if (type === 'uri' && !/^https?:\/\/\S+$/.test(s)) throw new ValidationError(`${name}: expected an http(s) URL`);
      if (name === 'doi') return bareDoi(s) || undefined;
      if (name === 'isbn') {
        const n = isbn13(s);
        if (!n) throw new ValidationError(`isbn: '${s}' isn't an ISBN`);
        return n;
      }
      return s;
    }
  }
}

/**
 * A source validated and cleaned: empties dropped, keys in model order, the DOI and ISBN in the form they're kept in.
 * An unknown field, or a value of the wrong kind, throws ValidationError.
 */
export function normalise(source: Record<string, unknown>): Bib {
  const key = str(source.key ?? '', 'key');
  if (!KEY_RE.test(key)) throw new ValidationError('key: letters, digits and _:.-/+ only, and not empty');
  const entrytype = source.entrytype === undefined || source.entrytype === '' ? 'misc' : source.entrytype;
  if (!isEntryType(entrytype)) throw new ValidationError(`entrytype: unknown '${String(entrytype)}'`);
  for (const name of Object.keys(source)) {
    if (!['key', 'entrytype', 'title'].includes(name) && !Object.hasOwn(FIELDS, name)) throw new ValidationError(`unknown field '${name}'`);
  }
  const out: Bib = { key, entrytype };
  const title = source.title === undefined ? '' : str(source.title, 'title');
  if (title) out.title = title;
  for (const name of FIELD_NAMES) {
    const v = clean(name, source[name]);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** The bibliographic props of a `source@1` value, as they are (no checks: the gestalt has done those). */
export function bibOf(value: Record<string, unknown>): Bib {
  const out: Bib = { key: String(value.key ?? ''), entrytype: isEntryType(value.entrytype) ? value.entrytype : 'misc' };
  if (typeof value.title === 'string' && value.title) out.title = value.title;
  for (const name of FIELD_NAMES) {
    const v = value[name];
    if (typeof v === 'string' || typeof v === 'number' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) out[name] = v as FieldValue;
  }
  return out;
}

/** `key`, or `key-2`, `key-3`, … when that's taken. */
export function uniqueKey(key: string, taken: (key: string) => boolean): string {
  let out = key;
  for (let n = 2; taken(out); n++) out = `${key}-${n}`;
  return out;
}

/** A key from a title, for a source that has none. */
export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

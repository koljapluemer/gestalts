/**
 * BibTeX/biblatex text to sources. A reader for what reference managers, publishers and Google Scholar paste, not a TeX
 * engine: `@string` macros and `#` joins are expanded; `@comment` and `@preamble` are skipped; common LaTeX (accents,
 * special letters, escapes, text commands, dashes) becomes Unicode; anything else drops its command and keeps its
 * text. Fields outside the model are dropped.
 */

import { DATE_RE, FIELDS, joinName, type Bib, type EntryType, type FieldName, isEntryType } from './fields';

/** One entry as written: its fields' values with macros and joins expanded, braces and LaTeX kept. */
export type RawEntry = { type: string; key: string; fields: Record<string, string> };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  get done() { return this.i >= this.s.length; }
  peek() { return this.s[this.i]; }
  space() { while (!this.done && /\s/.test(this.s[this.i])) this.i++; }
  eat(c: string) { this.space(); if (this.s[this.i] !== c) return false; this.i++; return true; }
  ident() {
    this.space();
    const m = /^[^\s"#%'(),={}]+/.exec(this.s.slice(this.i));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }
  /** From just after an opening `{`, to its partner; the text between. */
  braced() {
    let depth = 1;
    const start = this.i;
    for (; !this.done; this.i++) {
      const c = this.s[this.i];
      if (c === '\\') { this.i++; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return this.s.slice(start, this.i++);
    }
    throw new Error('unbalanced braces');
  }
  quoted() {
    let depth = 0;
    const start = this.i;
    for (; !this.done; this.i++) {
      const c = this.s[this.i];
      if (c === '\\') { this.i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) return this.s.slice(start, this.i++);
    }
    throw new Error('unterminated quote');
  }
}

function value(r: Reader, strings: Map<string, string>): string {
  const parts: string[] = [];
  do {
    r.space();
    const c = r.peek();
    if (c === '{') { r.i++; parts.push(r.braced()); }
    else if (c === '"') { r.i++; parts.push(r.quoted()); }
    else {
      const id = r.ident();
      if (!id) throw new Error('expected a value');
      parts.push(/^\d+$/.test(id) ? id : (strings.get(id.toLowerCase()) ?? id));
    }
  } while (r.eat('#'));
  return parts.join('');
}

/** The entries in `text`, as written. Broken entries are skipped. */
export function readEntries(text: string): RawEntry[] {
  const r = new Reader(text);
  const strings = new Map<string, string>();
  const out: RawEntry[] = [];
  while (!r.done) {
    const at = r.s.indexOf('@', r.i);
    if (at < 0) break;
    r.i = at + 1;
    const type = r.ident().toLowerCase();
    r.space();
    const open = r.peek();
    if (open !== '{' && open !== '(') continue;
    r.i++;
    const close = open === '{' ? '}' : ')';
    const start = r.i;
    try {
      if (type === 'comment' || type === 'preamble') {
        if (open === '{') r.braced(); else r.i = r.s.indexOf(')', r.i) + 1 || r.s.length;
        continue;
      }
      if (type === 'string') {
        const name = r.ident().toLowerCase();
        if (r.eat('=')) strings.set(name, value(r, strings));
        r.eat(close);
        continue;
      }
      const key = r.ident();
      const fields: Record<string, string> = {};
      if (r.eat(',')) {
        for (;;) {
          r.space();
          if (r.eat(close)) break;
          const name = r.ident().toLowerCase();
          if (!name || !r.eat('=')) throw new Error('expected a field');
          fields[name] = value(r, strings);
          if (!r.eat(',')) { if (!r.eat(close)) throw new Error(`expected ${close}`); break; }
        }
      } else if (!r.eat(close)) throw new Error(`expected ${close}`);
      out.push({ type, key, fields });
    } catch {
      // a broken entry: go on after where it began
      r.i = start;
    }
  }
  return out;
}

// LaTeX to text. Escaped characters stand in as private-use characters until braces are gone.
const KEEP: Record<string, string> = { '{': '\uE000', '}': '\uE001', '~': '\uE002', '\\': '\uE003' };
const RESTORE = Object.fromEntries(Object.entries(KEEP).map(([k, v]) => [v, k]));
const ACCENTS: Record<string, string> = {
  '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', u: '̆', '.': '̇', '"': '̈',
  r: '̊', H: '̋', v: '̌', c: '̧', k: '̨',
};
const LETTERS: Record<string, string> = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  textendash: '–', textemdash: '—', ldots: '…', dots: '…', textellipsis: '…', S: '§', P: '¶', copyright: '©',
  textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”', textregistered: '®',
  texttrademark: '™', textdegree: '°', euro: '€', pounds: '£', textbackslash: KEEP['\\'],
  textasciitilde: KEEP['~'], textasciicircum: '^', textunderscore: '_', textbar: '|', textless: '<', textgreater: '>',
};

/** `s` (LaTeX) as plain text. */
export function decodeLatex(s: string): string {
  // `\\` breaks a line, `\-` marks where a word may be hyphenated
  let t = s.replace(/\\\\/g, ' ').replace(/\\-/g, '').replace(/\\([{}])/g, (_, c: string) => KEEP[c]);
  t = t.replace(/\\([&%$#_ ,;:!])/g, (_, c: string) => (/[ ,;:!]/.test(c) ? ' ' : c));
  const base = (b: string) => (b === '\\i' ? 'i' : b === '\\j' ? 'j' : b);
  // accents: \'e \'{e} \' e \c{c} \c c, also over \i
  t = t.replace(/\\([`'^"~=.])\s*(?:\{\s*(\\?[A-Za-z])\s*\}|(\\?[A-Za-z]))/g, (_, a: string, x?: string, y?: string) => base((x ?? y)!) + ACCENTS[a]);
  t = t.replace(/\\([uvHckr])(?:\s*\{\s*(\\?[A-Za-z])\s*\}|\s+(\\?[A-Za-z]))/g, (_, a: string, x?: string, y?: string) => base((x ?? y)!) + ACCENTS[a]);
  t = t.replace(/\\([A-Za-z]+)\s*(\{\})?/g, (_, name: string) => (Object.hasOwn(LETTERS, name) ? LETTERS[name] : ''));
  t = t.replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, ' ').replace(/[{}]/g, '');
  t = t.replace(/[\uE000-\uE003]/g, (c) => RESTORE[c]);
  return t.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Splits at `sep` (a regex source) where it's outside braces. */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0) {
      const m = sep.exec(s.slice(i));
      if (m && m.index === 0) { out.push(s.slice(start, i)); i += m[0].length - 1; start = i + 1; }
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Whether a name word starts lowercase, as BibTeX decides it: a braced word counts as uppercase. */
function lowerWord(w: string): boolean {
  if (w.startsWith('{')) return false;
  const c = decodeLatex(w).charAt(0);
  return c !== '' && c === c.toLowerCase() && c !== c.toUpperCase();
}

/** One BibTeX name as `family, given` (or one unsplit name, for a single braced word like `{Some Corp}`). */
export function bibtexName(raw: string): string {
  const parts = splitTop(raw.trim(), /^\s*,\s*/).map((p) => p.trim());
  const words = (s: string) => splitTop(s, /^\s+/).filter(Boolean);
  const text = (ws: string[]) => decodeLatex(ws.join(' '));
  if (parts.length === 1) {
    const ws = words(parts[0]);
    if (ws.length === 1) return decodeLatex(ws[0]);
    // First von Last: von from the first lowercase word, Last after the von words (at least the last word)
    const vonStart = ws.slice(0, -1).findIndex(lowerWord);
    if (vonStart < 0) return joinName({ given: text(ws.slice(0, -1)), family: text(ws.slice(-1)) });
    let vonEnd = vonStart;
    for (let i = vonStart; i < ws.length - 1; i++) if (lowerWord(ws[i])) vonEnd = i + 1;
    return joinName({ given: text(ws.slice(0, vonStart)), prefix: text(ws.slice(vonStart, vonEnd)), family: text(ws.slice(vonEnd)) });
  }
  // von Last, [Jr,] First
  const first = words(parts[0]);
  let n = 0;
  while (n < first.length - 1 && lowerWord(first[n])) n++;
  return joinName({
    prefix: text(first.slice(0, n)),
    family: text(first.slice(n)),
    suffix: parts.length === 3 ? decodeLatex(parts[1]) : undefined,
    given: decodeLatex(parts.at(-1)!),
  });
}

// legacy bibtex/biblatex types and fields
const TYPE_ALIASES: Record<string, [EntryType, Record<string, string>]> = {
  conference: ['inproceedings', {}],
  electronic: ['online', {}],
  www: ['online', {}],
  phdthesis: ['thesis', { type: 'phdthesis' }],
  mastersthesis: ['thesis', { type: 'mathesis' }],
  techreport: ['report', { type: 'techreport' }],
};
const FIELD_ALIASES: Record<string, string> = { journal: 'journaltitle', address: 'location', school: 'institution', archiveprefix: 'eprinttype' };

function month(v: string): number | undefined {
  const s = v.trim().toLowerCase();
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : undefined; }
  const i = MONTHS.indexOf(s.slice(0, 3));
  return i < 0 ? undefined : i + 1;
}

/** A raw entry as a source (not yet normalised: see `normalise`). */
export function convert(entry: RawEntry): Bib {
  let type = entry.type;
  let fixed: Record<string, string> = {};
  if (Object.hasOwn(TYPE_ALIASES, type)) [type, fixed] = TYPE_ALIASES[type];
  const out: Bib = { key: entry.key.replace(/[^A-Za-z0-9_:.\-/+]/g, '_') || 'source', entrytype: isEntryType(type) ? type : 'misc' };

  const fields: Record<string, string> = {};
  for (const [name, v] of Object.entries(entry.fields)) fields[FIELD_ALIASES[name] ?? name] = v;
  for (const [name, v] of Object.entries(fixed)) fields[name] ??= v;

  const { year, month: m } = fields;
  delete fields.year;
  delete fields.month;
  if (year && !fields.date) {
    let date = decodeLatex(year);
    const mm = m ? month(decodeLatex(m)) : undefined;
    if (mm && /^\d{4}$/.test(date)) date = `${date}-${String(mm).padStart(2, '0')}`;
    fields.date = date;
  }
  const hp = fields.howpublished;
  if (hp && !fields.url) {
    const u = /^(?:\\url\{)?(https?:\/\/[^\s}]+)\}?$/.exec(hp.trim());
    if (u) { fields.url = u[1]; delete fields.howpublished; }
  }

  for (const [name, raw] of Object.entries(fields)) {
    if (name === 'title') { const t = decodeLatex(raw); if (t) out.title = t; continue; }
    if (!Object.hasOwn(FIELDS, name)) continue;
    const field = name as FieldName;
    const type = FIELDS[field];
    if (type === 'name') out[field] = splitTop(raw, /^\s+and\s+/i).map(bibtexName).filter(Boolean);
    else if (type === 'list') out[field] = splitTop(raw, /^\s+and\s+/i).map(decodeLatex).filter(Boolean);
    else if (type === 'integer') { const s = raw.trim(); if (/^\d+$/.test(s)) out[field] = Number(s); }
    else if (type === 'date') { const s = decodeLatex(raw); if (DATE_RE.test(s)) out[field] = s; }
    else if (type === 'uri' || type === 'verbatim') { const s = raw.replace(/^\s*\\url\{(.*)\}\s*$/, '$1').replace(/[{}]/g, '').trim(); if (s) out[field] = s; }
    else if (type === 'range') { const s = raw.replace(/[{}]/g, '').replace(/\s+/g, '').replace(/[–—]/g, '--'); if (s) out[field] = s; }
    else { const s = decodeLatex(raw); if (s) out[field] = s; }
  }
  return out;
}

/** The sources in BibTeX text. Throws when there are none. */
export function parseBibtex(text: string): Bib[] {
  const entries = readEntries(text).map(convert);
  if (!entries.length) throw new Error('no BibTeX entries found');
  return entries;
}

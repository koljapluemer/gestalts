import type { JsonMap } from './fields';
import type { Json } from './types';

const asMap = (v: Json | null | undefined): JsonMap | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * A note as read (doc/architecture.md#the-note-component): whatever it has, as Markdown in reading order. The title
 * as a heading, its tasks, its text (or a quote, a flashcard's front and back, its cards, a link, a canvas's text),
 * then `extra`. Nothing is cut: the one-line form (`noteLine`) is for list rows only.
 */

/** One piece of a note as read; `kind` styles it (`title`, `tasks`, `main`, `card`, `link`, `canvas`, `extra`, or a lens's own). */
export type GistBlock = { kind: string; markdown: string };

/**
 * A part of a note as read, from the fields in `keys`. Once it gives blocks, those fields are used up: no later part
 * shows them again. A lens's part (`Lens.gist`) comes before the built-in ones, so it can show their fields its way.
 */
export type GistPart = {
  keys: string[];
  blocks?: (note: JsonMap) => GistBlock[];
  /** the note in one line, for list rows, if this part can name it */
  line?: (note: JsonMap) => string | undefined;
};

export type GistOptions = {
  /** the title as a heading (default); off where the caller shows it itself */
  title?: boolean;
  /** `tasks` (default on) */
  tasks?: boolean;
  /** `extra` (default on) */
  extra?: boolean;
  /** only parts whose fields (those the note has) all pass, e.g. those the full view doesn't show as properties */
  only?: (key: string) => boolean;
};

const text = (v: Json | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const block = (kind: string, markdown: string | undefined): GistBlock[] => (markdown ? [{ kind, markdown }] : []);
const frontBack = (front: string | undefined, back: string | undefined) =>
  front && back ? `${front}\n\n---\n\n${back}` : front ?? back;

/** A URL without its scheme and trailing slash, to read. */
const bareUrl = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');

const cardsOf = (v: Json | undefined) =>
  (Array.isArray(v) ? v : []).flatMap((c) => { const m = asMap(c); return m ? [{ front: text(m.front), back: text(m.back) }] : []; });

const canvasTexts = (v: Json | undefined) =>
  (Array.isArray(asMap(v ?? null)?.nodes) ? (asMap(v ?? null)!.nodes as Json[]) : []).flatMap((n) => { const t = text(asMap(n)?.text); return t ? [t] : []; });

const TASKS: GistPart = { keys: ['tasks'], blocks: (n) => block('tasks', text(n.tasks)) };
const EXTRA: GistPart = { keys: ['extra'], blocks: (n) => block('extra', text(n.extra)) };

/** The built-in parts after the tasks and a lens's parts, in reading order; `extra` comes last. */
const CONTENT: GistPart[] = [
  { keys: ['main'], blocks: (n) => block('main', text(n.main)) },
  { keys: ['front', 'back'], blocks: (n) => block('card', frontBack(text(n.front), text(n.back))), line: (n) => text(n.front) },
  {
    keys: ['cards'],
    blocks: (n) => cardsOf(n.cards).flatMap((c) => block('card', frontBack(c.front, c.back))),
    line: (n) => cardsOf(n.cards).find((c) => c.front)?.front,
  },
  {
    keys: ['url'],
    blocks: (n) => { const u = text(n.url); return block('link', u && `[${bareUrl(u)}](${u})`); },
    line: (n) => { const u = text(n.url); return u && bareUrl(u); },
  },
  { keys: ['publish'], blocks: (n) => block('main', text(n.publish)) },
  {
    keys: ['canvas'],
    blocks: (n) => block('canvas', canvasTexts(n.canvas).join('\n\n---\n\n') || undefined),
    line: (n) => canvasTexts(n.canvas)[0],
  },
];

/** The note's parts, as read, in order. */
export function noteGist(note: JsonMap, opts: GistOptions = {}, parts: GistPart[] = []): GistBlock[] {
  const { title = true, tasks = true, extra = true, only } = opts;
  const used = new Set<string>();
  const out: GistBlock[] = [];
  const t = text(note.title);
  if (title && t && (!only || only('title'))) out.push({ kind: 'title', markdown: `## ${t}` });
  const order = [...(tasks ? [TASKS] : []), ...parts, ...CONTENT, ...(extra ? [EXTRA] : [])];
  for (const part of order) {
    const has = part.keys.filter((k) => note[k] !== undefined);
    if (!has.length || has.some((k) => used.has(k)) || (only && !has.every(only))) continue;
    const blocks = part.blocks?.(note) ?? [];
    if (!blocks.length) continue;
    out.push(...blocks);
    for (const k of part.keys) used.add(k);
  }
  return out;
}

/** The blocks as one Markdown text. */
export const gistMarkdown = (blocks: GistBlock[]) => blocks.map((b) => b.markdown).join('\n\n');

/** Markdown's first line, as plain text: no heading marks, emphasis, code ticks or link syntax. */
export function plainLine(markdown: string): string {
  const line = markdown.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(\S(?:.*?\S)?)\1/g, '$2')
    .trim();
}

/**
 * The note in one line, for list rows (search results, relationships, links to it): its title, else a lens's line,
 * else the first line of `main`, else a built-in part's (a front, a link, a canvas's first text), else of `extra`;
 * `''` when it has none of them (never its YAML).
 */
export function noteLine(note: JsonMap, parts: GistPart[] = []): string {
  const candidates = [
    () => text(note.title),
    ...parts.map((p) => () => p.line?.(note)),
    () => text(note.main),
    ...CONTENT.map((p) => () => p.line?.(note)),
    () => text(note.extra),
  ];
  for (const c of candidates) {
    const line = c();
    if (line && plainLine(line)) return plainLine(line);
  }
  return '';
}

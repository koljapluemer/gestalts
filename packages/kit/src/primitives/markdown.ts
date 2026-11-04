import { Marked, type MarkedExtension, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import temml from 'temml';
import 'temml/dist/Temml-Local.css';

/**
 * Markdown as sanitized HTML, as notes write it:
 * - single newlines break lines
 * - TeX math as Pandoc's `tex_math_dollars`: `$…$` inline (no whitespace inside its ends, the closing `$` not
 *   followed by a digit, so `$20 and $30` stays text), `$$…$$` displayed, across lines but not a blank one
 * - `[[target]]` / `[[target|label]]` link to a note, `![[blob]]` / `![[blob|alt]]` embed a blob
 * Code spans and fences hold neither math nor references (marked tokenizes them first), and math holds no references.
 */

export type MathSpan = { from: number; to: number; tex: string; display: boolean };

const SPACE = /\s/;
const BLANK_LINE = /^\n[ \t]*(\n|$)/;

/** The math opening with the `$` at `i`, or null. */
export function mathAt(src: string, i: number): MathSpan | null {
  if (src[i] !== '$') return null;
  if (src[i + 1] === '$') {
    for (let j = i + 2; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '\n' && BLANK_LINE.test(src.slice(j))) return null;
      else if (src.startsWith('$$', j)) {
        const tex = src.slice(i + 2, j);
        return tex.trim() ? { from: i, to: j + 2, tex, display: true } : null;
      }
    }
    return null;
  }
  if (i + 1 >= src.length || SPACE.test(src[i + 1])) return null;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '\n') return null;
    else if (src[j] === '$') {
      if (SPACE.test(src[j - 1]) || /\d/.test(src[j + 1] ?? '')) return null;
      return { from: i, to: j + 1, tex: src.slice(i + 1, j), display: false };
    }
  }
  return null;
}

/** How references and embeds render; the defaults show them as written. */
export type MarkdownLinks = {
  /** a note reference: its label and whether the note exists */
  reference?: (target: string) => { label: string; exists: boolean };
  /** an embed's `src`, if there is one yet */
  embed?: (target: string) => string | null;
};

type MathToken = Tokens.Generic & { tex: string; display: boolean };
type RefToken = Tokens.Generic & { target: string; label?: string; embed: boolean };

const REF = /^(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/;

function escaped(text: string, at: number) {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let links: MarkdownLinks = {};

export type EmbedKind = 'image' | 'video' | 'audio' | 'file';

const KINDS: Record<string, EmbedKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', avif: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', ogg: 'audio', wav: 'audio', m4a: 'audio', opus: 'audio', flac: 'audio',
};

/** What a blob is, by its extension. */
export const embedKind = (name: string): EmbedKind => KINDS[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'file';

/** An embedded blob: images, videos and audio shown, anything else as a link. */
function embedHtml(target: string, src: string, label: string | undefined) {
  const s = escapeHtml(src);
  switch (embedKind(target)) {
    case 'image': return `<img class="md-embed" src="${s}" alt="${escapeHtml(label ?? '')}">`;
    case 'video': return `<video class="md-embed" src="${s}" controls preload="metadata"${label ? ` title="${escapeHtml(label)}"` : ''}></video>`;
    case 'audio': return `<audio src="${s}" controls preload="metadata"${label ? ` title="${escapeHtml(label)}"` : ''}></audio>`;
    default: return `<a href="${s}" download="${escapeHtml(target)}">${escapeHtml(label ?? target)}</a>`;
  }
}

const extensions: MarkedExtension = {
  extensions: [
    {
      name: 'math',
      level: 'inline',
      start: (src) => {
        for (let i = src.indexOf('$'); i >= 0; i = src.indexOf('$', i + 1)) if (!escaped(src, i)) return i;
        return undefined;
      },
      tokenizer(src) {
        const span = mathAt(src, 0);
        return span ? { type: 'math', raw: src.slice(0, span.to), tex: span.tex, display: span.display } : undefined;
      },
      renderer: (t) => temml.renderToString((t as MathToken).tex, { displayMode: (t as MathToken).display, throwOnError: false }),
    },
    {
      name: 'reference',
      level: 'inline',
      start: (src) => {
        const i = src.search(/!?\[\[/);
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = REF.exec(src);
        return m ? { type: 'reference', raw: m[0], embed: m[1] === '!', target: m[2].trim(), label: m[3]?.trim() } : undefined;
      },
      renderer(t) {
        const { target, label, embed } = t as RefToken;
        if (embed) {
          const src = links.embed?.(target);
          return src
            ? embedHtml(target, src, label)
            : `<span class="text-base-content/50 line-through" title="not attached">${escapeHtml(label ?? target)}</span>`;
        }
        const ref = links.reference?.(target) ?? { label: target, exists: true };
        const text = escapeHtml(label ?? ref.label).replaceAll('$', '&#36;');
        return ref.exists
          ? `<a class="link link-hover" href="#" data-note="${escapeHtml(target)}">${text}</a>`
          : `<span class="text-base-content/50 line-through" title="no such note">${text}</span>`;
      },
    },
  ],
};

const marked = new Marked(extensions, { breaks: true, gfm: true });

// MathML's `form` (prefix/postfix fences), which DOMPurify doesn't know; note links carry `data-note`
// Blob embeds are object URLs (`blob:`), which DOMPurify's default URI allowlist would strip.
const SANITIZE = {
  ADD_ATTR: ['form', 'data-note', 'target', 'controls', 'preload', 'download'],
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

let hooked = false;

/** Markdown as sanitized HTML. External links open in a new tab; note links are handled by the app. */
export function renderMarkdown(text: string, with_: MarkdownLinks = {}): string {
  if (!hooked) {
    // registered on first use: DOMPurify needs a DOM, which tests importing this module may not have
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href') && !node.hasAttribute('data-note') && !node.hasAttribute('download')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener');
      }
    });
    hooked = true;
  }
  links = with_;
  try {
    return DOMPurify.sanitize(marked.parse(text, { async: false }), SANITIZE);
  } finally {
    links = {};
  }
}

/** The `[[targets]]` and `![[embeds]]` of a Markdown text, outside code and math, in order. */
export function references(text: string): { target: string; label?: string; embed: boolean }[] {
  const out: { target: string; label?: string; embed: boolean }[] = [];
  marked.walkTokens(marked.lexer(text), (t) => {
    if (t.type === 'reference') {
      const r = t as RefToken;
      out.push({ target: r.target, label: r.label, embed: r.embed });
    }
  });
  return out;
}

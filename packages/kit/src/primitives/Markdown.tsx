import { useMemo } from 'react';
import { useBlobUrls, useQuery } from '@gestalts/view';
import { references, renderMarkdown } from './markdown';
import './markdown.css';

type Props = {
  text: string;
  /** a `[[note]]` link was clicked: the note's id; without it links are plain text */
  onOpen?: (id: string) => void;
  className?: string;
};

/**
 * A note's Markdown: math, `[[id|label]]` links to notes (labelled with the note's title when they have no label of
 * their own; struck through when it's missing) and `![[blob]]` embeds.
 */
export function Markdown({ text, onOpen, className = '' }: Props) {
  const embeds = useMemo(() => [...text.matchAll(/!\[\[([^\]|\n]+)/g)].map((m) => m[1].trim()), [text]);
  const urls = useBlobUrls(embeds);
  const ids = useMemo(() => [...new Set(references(text).filter((r) => !r.embed).map((r) => r.target))], [text]);
  const linked = useQuery(ids.length ? { gestalt: 'note@1', ids, fields: ['title', 'main'], limit: ids.length } : null).items;
  const html = useMemo(() => renderMarkdown(text, {
    reference: (target) => {
      const note = linked.find((n) => n.id === target);
      if (!note) return { label: target, exists: false };
      const { title, main } = note.value;
      return { label: typeof title === 'string' ? title : typeof main === 'string' ? main.split('\n')[0].slice(0, 60) : target, exists: true };
    },
    embed: (target) => urls[target] ?? null,
  }), [text, urls, linked]);
  return (
    <div
      className={`md ${onOpen ? '' : 'md-inert'} ${className}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-note]');
        if (!a) return;
        e.preventDefault();
        onOpen?.(a.getAttribute('data-note')!);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

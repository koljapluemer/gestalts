import { useEffect, useMemo, useState } from 'react';
import { noteLabel, useRepo, useRepoVersion } from '@gestalts/sdk';
import { renderMarkdown } from './markdown';
import './markdown.css';

type Props = {
  text: string;
  /** a `[[note]]` link was clicked: the note's key; without it links are plain text */
  onOpen?: (key: string) => void;
  className?: string;
};

/**
 * A note's Markdown: math, `[[id|label]]` links to notes (labelled with the note's title when they have no label of
 * their own; struck through when it's missing) and `![[blob]]` embeds.
 */
export function Markdown({ text, onOpen, className = '' }: Props) {
  const repo = useRepo();
  const version = useRepoVersion();
  const embeds = useMemo(() => [...text.matchAll(/!\[\[([^\]|\n]+)/g)].map((m) => m[1].trim()), [text]);
  const urls = useBlobUrls(embeds);
  const html = useMemo(() => renderMarkdown(text, {
    reference: (target) => {
      const key = repo.keyOf(target);
      const note = key ? repo.get(key) : undefined;
      return note ? { label: noteLabel(note), exists: true } : { label: target, exists: false };
    },
    embed: (target) => urls[target] ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the notes links are labelled from
  }), [text, repo, urls, version]);
  return (
    <div
      className={`md ${onOpen ? '' : 'md-inert'} ${className}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-note]');
        if (!a) return;
        e.preventDefault();
        const key = repo.keyOf(a.getAttribute('data-note')!);
        if (key) onOpen?.(key);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Object URLs for the blobs named, filled in as they load. */
function useBlobUrls(names: string[]): Record<string, string> {
  const repo = useRepo();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = names.join('\n');
  useEffect(() => {
    let live = true;
    for (const name of key ? key.split('\n') : []) {
      void repo.blobUrl(name).then((url) => { if (live && url) setUrls((u) => (u[name] === url ? u : { ...u, [name]: url })); });
    }
    return () => { live = false; };
  }, [repo, key]);
  return urls;
}

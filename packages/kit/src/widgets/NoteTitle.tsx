import type { JsonMap } from '@gestalts/view';
import { Markdown } from '../primitives';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * What a note is called, as Markdown source: its title, else the first line of `main` that says something (without
 * its heading, list or quote marker); empty when it has neither.
 */
export function noteHeadline(v: JsonMap): string {
  const title = str(v.title).trim();
  if (title) return title;
  const line = str(v.main).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
}

/** A note's headline (`noteHeadline`) rendered as one line of Markdown; "(empty)" when there's none. */
export function NoteTitle({ value, className = '', onOpen }: { value: JsonMap; className?: string; onOpen?: (id: string) => void }) {
  const text = noteHeadline(value);
  if (!text) return <span className={`text-base-content/50 ${className}`}>(empty)</span>;
  return <Markdown inline text={text} onOpen={onOpen} className={className} />;
}

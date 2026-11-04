import { foldText } from './text';

/** `text` with every word starting with one of `terms` (compared folded) marked. */
export function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const parts = text.split(/([\p{L}\p{N}]+)/u);
  return (
    <>
      {parts.map((part, i) => {
        const folded = foldText(part);
        return terms.some((t) => t && folded.startsWith(t)) ? <mark key={i} className="rounded-sm bg-primary/30 text-inherit">{part}</mark> : part;
      })}
    </>
  );
}

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { definePerspective, useHost, type Query } from '@gestalts/sdk';
import { quoteOf } from './quote';
import type { Quote } from './queue';

/**
 * The quotes: added and edited as notes in the host's (the quote lens starts a changed one's practice over), deleted
 * here with their learner state.
 */
export const Quotes = definePerspective<{ quotes: Query }>({
  id: 'quotes-list',
  title: 'Quotes',
  data: { quotes: { gestalt: 'quote@1', tagsNone: ['retired'] } },
  Component: ({ data, repo }) => {
    const quotes = data.quotes.flatMap((n) => quoteOf(n) ?? []).sort((a, b) => a.text.localeCompare(b.text));
    const host = useHost();
    const add = () => void host.createNote?.({ gestalt: 'quote@1', preset: 'gestalt' });
    const remove = (q: Quote) => {
      if (confirm('Delete this quote, and what you learned of it?')) void repo.delete(q.key);
    };
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        {host.createNote && <button type="button" className="btn btn-sm self-start" onClick={add}><Plus className="size-4" /> Add a quote</button>}
        {!quotes.length && <p className="p-8 text-center text-base-content/60">No quotes yet.</p>}
        <ul className="flex flex-col gap-2">
          {quotes.map((q) => (
            <li key={q.key} className="flex items-start gap-2 rounded-box bg-base-100 p-3 shadow-sm">
              <div className="min-w-0 flex-1">
                <p>{q.text}</p>
                {q.attribution && <p className="text-sm italic text-base-content/60">— {q.attribution}</p>}
              </div>
              {host.openNote && (
                <button type="button" className="btn btn-ghost btn-xs btn-square" title="Edit (changing the words starts its practice over)" onClick={() => host.openNote?.(q.key)}>
                  <Pencil className="size-3.5" />
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-xs btn-square" title="Delete" onClick={() => remove(q)}><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      </div>
    );
  },
});

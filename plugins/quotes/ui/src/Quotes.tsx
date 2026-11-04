import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { definePerspective, type Query } from '@gestalts/sdk';
import { quoteOf, saveQuote } from './quote';
import type { Quote } from './queue';

type Editing = { key?: string; text: string; attribution: string };

/** The quotes: add, edit, delete. Deleting one deletes its learner state too. */
export const Quotes = definePerspective<{ quotes: Query }>({
  id: 'quotes-list',
  title: 'Quotes',
  data: { quotes: { gestalt: 'quote@1', tagsNone: ['retired'] } },
  Component: ({ data, repo }) => {
    const quotes = data.quotes.flatMap((n) => quoteOf(n) ?? []).sort((a, b) => a.text.localeCompare(b.text));
    const [editing, setEditing] = useState<Editing | null>(null);
    const [saving, setSaving] = useState(false);
    const save = async () => {
      if (!editing?.text.trim()) return;
      setSaving(true);
      try { await saveQuote(repo, editing.key, editing.text, editing.attribution); setEditing(null); } finally { setSaving(false); }
    };
    const remove = (q: Quote) => {
      if (confirm('Delete this quote, and what you learned of it?')) void repo.delete(q.key);
    };
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        {editing ? (
          <form className="card bg-base-100 shadow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="card-body gap-2 p-4">
              <textarea className="textarea w-full" rows={3} placeholder="The quote" autoFocus value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
              <input className="input w-full" placeholder="Who said it (optional)" value={editing.attribution}
                     onChange={(e) => setEditing({ ...editing, attribution: e.target.value })} />
              {editing.key && <p className="text-xs text-base-content/60">Changing the words starts its practice over.</p>}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="btn btn-sm btn-primary" disabled={saving || !editing.text.trim()}>Save</button>
              </div>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-sm self-start" onClick={() => setEditing({ text: '', attribution: '' })}><Plus className="size-4" /> Add a quote</button>
        )}
        {!quotes.length && !editing && <p className="p-8 text-center text-base-content/60">No quotes yet.</p>}
        <ul className="flex flex-col gap-2">
          {quotes.map((q) => (
            <li key={q.key} className="flex items-start gap-2 rounded-box bg-base-100 p-3 shadow-sm">
              <div className="min-w-0 flex-1">
                <p>{q.text}</p>
                {q.attribution && <p className="text-sm italic text-base-content/60">— {q.attribution}</p>}
              </div>
              <button type="button" className="btn btn-ghost btn-xs btn-square" title="Edit" onClick={() => setEditing({ key: q.key, text: q.text, attribution: q.attribution ?? '' })}>
                <Pencil className="size-3.5" />
              </button>
              <button type="button" className="btn btn-ghost btn-xs btn-square" title="Delete" onClick={() => remove(q)}><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      </div>
    );
  },
});

import { useMemo, useState } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
import { definePerspective, newId, type Json } from '@gestalts/sdk';
import { GestaltBadges } from '../components';
import { MarkdownEditor } from '../primitives';
import { useReferenceTools, withInline } from '../widgets';

type Props = {
  /** initial title */
  title?: string;
  /** initial tags */
  tags?: string[];
  /** the note was written, under this key */
  onCreated: (key: string) => void;
  /** given: the form can be dismissed */
  onCancel?: () => void;
};

const splitTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

/** A form for a new note. Nothing is written until Create; the gestalt picker adds the tags it requires. */
export const NewNote = definePerspective<Record<string, never>, Props>({
  id: 'new-note',
  title: 'New note',
  data: {},
  Component: ({ repo, title: initialTitle = '', tags: initialTags = [], onCreated, onCancel }) => {
    const [id] = useState(newId);
    const [title, setTitle] = useState(initialTitle);
    const [tagText, setTagText] = useState(initialTags.join(', '));
    const [gestalt, setGestalt] = useState('');
    const [main, setMain] = useState('');
    const [state, setState] = useState<{ saving: boolean; error?: string }>({ saving: false });
    const gestalts = useMemo(() => repo.gestalts().sort((a, b) => a.name.localeCompare(b.name)), [repo]);
    const refs = useReferenceTools();

    const tags = splitTags(tagText);
    // a `[[reference]]` in the text is also an `inline` relationship
    const value: Record<string, Json> = withInline({ id, ...(title.trim() ? { title: title.trim() } : {}), tags, ...(main.trim() ? { main } : {}) });
    // YAML reads JSON, so the core can check the note before it exists
    const live = repo.inspect(id, JSON.stringify(value));

    const pickGestalt = (g: string) => {
      setGestalt(g);
      const def = gestalts.find((d) => `${d.name}@${d.version}` === g);
      if (def) setTagText(splitTags([tagText, ...def.requires_tags].join(',')).join(', '));
    };

    const create = async () => {
      if (state.saving) return;
      setState({ saving: true });
      try {
        await repo.putValue(id, value);
        setState({ saving: false });
        onCreated(id);
      } catch (e) {
        setState({ saving: false, error: e instanceof Error ? e.message : String(e) });
      }
    };

    return (
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => { e.preventDefault(); void create(); }}
        onKeyDown={(e) => {
          // Esc that closed the text's completion was handled already
          if (e.defaultPrevented) return;
          if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void create(); }
        }}
      >
        <h2 className="text-lg font-semibold">New note</h2>
        <label className="floating-label">
          <span>Title</span>
          <input className="input w-full" placeholder="Title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="floating-label flex-1">
            <span>Tags</span>
            <input className="input w-full" placeholder="Tags, comma separated" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </label>
          <label className="floating-label sm:w-56">
            <span>Gestalt</span>
            <select className="select w-full" value={gestalt} onChange={(e) => pickGestalt(e.target.value)}>
              <option value="">No gestalt</option>
              {gestalts.map((g) => {
                const name = `${g.name}@${g.version}`;
                return <option key={name} value={name} title={g.description ?? undefined}>{name}</option>;
              })}
            </select>
          </label>
        </div>
        <MarkdownEditor value={main} onChange={setMain} onSave={() => void create()} search={refs.search} labelOf={refs.labelOf}
                        placeholder="Text (Markdown; [[ links a note)" minHeight="8rem" />
        <GestaltBadges gestalts={live.gestalts} lints={live.lints} />
        {live.lints.length > 0 && (
          <ul className="text-xs text-base-content/60">
            {live.lints.map((l) => <li key={`${l.gestalt} ${l.path} ${l.message}`}>{l.gestalt} {l.path}: {l.message}</li>)}
          </ul>
        )}
        {state.error && <p role="alert" className="text-sm text-error">Could not create the note: {state.error}</p>}
        <div className="flex justify-end gap-2">
          {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>}
          <button type="submit" className="btn btn-primary btn-sm" disabled={state.saving}>
            {state.saving ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
          </button>
        </div>
      </form>
    );
  },
});

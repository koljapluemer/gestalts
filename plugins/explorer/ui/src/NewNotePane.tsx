import { useState } from 'react';
import { definePane, useHost } from '@gestalts/sdk';
import { NewNote, SearchLayout } from '@gestalts/kit';

type Form = { title?: string; tags?: string[]; seq: number };

/** The new-note form on its own; the search's "+" refills it. A created note opens in the host's editor. */
export const NewNotePane = definePane({
  title: 'New note',
  Component: () => {
    const host = useHost();
    const [form, setForm] = useState<Form>({ seq: 0 });
    const reset = (prefill: Omit<Form, 'seq'> = {}) => setForm((f) => ({ ...prefill, seq: f.seq + 1 }));
    return (
      <SearchLayout onCreate={reset}>
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-2xl py-4">
            <NewNote key={form.seq} title={form.title} tags={form.tags} onCreated={(key) => { reset(); host.openNote?.(key); }} />
          </div>
        </div>
      </SearchLayout>
    );
  },
});

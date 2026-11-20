import { useState } from 'react';
import { useQuery, useWrite } from '@gestalts/view';

/** Notes with a tag, and a box to add one. */
export default function TaggedNotes() {
  const { items, hasMore, more, error } = useQuery({ gestalt: 'note@1', tags: { all: ['idea'] }, limit: 20, fields: ['main'] });
  const write = useWrite();
  const [text, setText] = useState('');
  const add = () => {
    void write.put({ gestalt: 'note@1', main: text, tags: ['idea'] });
    setText('');
  };
  if (error) return <div role="alert" className="alert alert-error m-4">{error}</div>;
  return (
    <div className="mx-auto flex h-full max-w-md flex-col gap-3 p-4">
      <div className="flex gap-2">
        <input className="input min-w-0 flex-1" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={add}>Add</button>
      </div>
      <ul className="flex flex-col gap-2 overflow-y-auto">
        {items.map((n) => <li key={n.id} className="card card-border bg-base-100 p-3">{String(n.value.main)}</li>)}
      </ul>
      {hasMore && <button type="button" className="btn btn-sm" onClick={more}>More</button>}
    </div>
  );
}

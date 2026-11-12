import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Markdown } from '@gestalts/kit';
import { useBlobUrl, useDoc, useParams, useQuery, useWrite, type Item } from '@gestalts/view';

/**
 * Interactive visualizations (`viz@1`): the list, or one of them between its intro and outro.
 *
 * Params: `viz`, the one shown (the list without it); `p.<name>`, that viz's own params, so a link keeps its state.
 *
 * A viz's page runs in a frame nested in this one, with nothing but postMessage: it can't reach any data.
 */
export default function Vizint() {
  const [params, setParams] = useParams();
  return params.viz ? <One id={params.viz} params={params} setParams={setParams} /> : <List open={(viz) => setParams({ viz })} />;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function List({ open }: { open: (id: string) => void }) {
  const { items, loading, error, hasMore, more } = useQuery({ gestalt: 'viz@1', fields: ['title', 'still'], order: { field: 'title' }, limit: 30 });
  if (error) return <div role="alert" className="alert alert-error m-4">{error}</div>;
  if (loading) return null;
  if (!items.length) return <p className="p-8 text-center text-base-content/60">No visualizations here yet.</p>;
  return (
    <div className="h-full overflow-y-auto">
      <ul className="mx-auto grid max-w-4xl grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 p-4">
        {items.map((v) => <Card key={v.id} item={v} open={open} />)}
      </ul>
      {hasMore && <div className="flex justify-center pb-6"><button type="button" className="btn btn-sm" onClick={more}>More</button></div>}
    </div>
  );
}

function Card({ item, open }: { item: Item; open: (id: string) => void }) {
  const still = useBlobUrl(str(item.value.still) || undefined);
  return (
    <li>
      <button type="button" className="card card-border h-full w-full bg-base-100 text-left hover:border-primary" onClick={() => open(item.id)}>
        <figure className="aspect-[5/3] bg-base-200">{still && <img src={still} alt="" className="h-full w-full object-cover object-top" />}</figure>
        <div className="card-body p-3"><span className="font-medium">{str(item.value.title) || item.id}</span></div>
      </button>
    </li>
  );
}

type Up = { source: 'viz'; type: 'ready' } | { source: 'viz'; type: 'resize'; height: number } | { source: 'viz'; type: 'error'; message: string }
  | { source: 'viz'; type: 'params'; params: Record<string, string> };

function One({ id, params, setParams }: { id: string; params: Record<string, string>; setParams: (p: Record<string, string>) => void }) {
  const doc = useDoc('viz@1', id);
  const v = doc?.value ?? {};
  const built = str(v.built);
  const still = useBlobUrl(str(v.still) || undefined);
  const { readBlob } = useWrite();
  const [page, setPage] = useState<{ built: string; html: string } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // the params the frame starts from; later changes come from the frame itself
  const start = useRef(params);
  useEffect(() => { start.current = params; }, [params]);

  useEffect(() => {
    if (!built) return;
    let live = true;
    void readBlob(built).then((bytes) => {
      if (live) setPage(bytes ? { built, html: new TextDecoder().decode(bytes) } : null);
    }, (e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [built, readBlob]);

  useEffect(() => {
    const onMessage = (e: MessageEvent<Up>) => {
      if (e.source !== frame.current?.contentWindow || e.data?.source !== 'viz') return;
      const m = e.data;
      if (m.type === 'ready') {
        const own = Object.fromEntries(Object.entries(start.current).filter(([k]) => k.startsWith('p.')).map(([k, val]) => [k.slice(2), val]));
        frame.current?.contentWindow?.postMessage({ type: 'params', params: own }, '*');
      } else if (m.type === 'resize') setHeight(m.height);
      else if (m.type === 'error') setError(m.message);
      else if (m.type === 'params') setParams({ viz: id, ...Object.fromEntries(Object.entries(m.params).map(([k, val]) => [`p.${k}`, val])) });
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [id, setParams]);

  if (!doc) return null;
  const html = page?.built === built ? page.html : null;
  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setParams({})}><ArrowLeft className="size-4" />All</button>
        <h1 className="text-2xl font-semibold">{str(v.title)}</h1>
        {str(v.intro) && <Markdown text={str(v.intro)} />}
        {html ? (
          <iframe
            key={built}
            ref={frame}
            title={str(v.title)}
            sandbox="allow-scripts"
            srcDoc={html}
            className="w-full border-0"
            style={{ height: height ?? 320 }}
          />
        ) : still ? <img src={still} alt="" className="w-full" /> : <p className="text-base-content/60">{built ? '' : 'Not built yet.'}</p>}
        {error && <div role="alert" className="alert alert-warning text-sm">{error}</div>}
        {str(v.outro) && <Markdown text={str(v.outro)} />}
      </article>
    </div>
  );
}

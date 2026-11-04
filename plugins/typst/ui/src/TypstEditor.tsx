import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { typst_lezer } from 'codemirror-lang-typst/lezer';
import { FileDown, Image, LoaderCircle, Quote, Upload } from 'lucide-react';
import { bib, blob, blobs, relationships, str, useBlobUrl, useNote, type IndexedNote, type Query, type ServiceClient, type Source, definePerspective } from '@gestalts/sdk';
import { CodeMirrorHost, SourcePicker, blobName, sourceSummary } from '@gestalts/kit';
import { assetsOf, citation, DOCUMENT_OF, sourceOf, withAsset, withPdf, withSource } from './typstDocument';

type Props = {
  /** key of the `typst-document@1` note */
  document: string;
  /** note ids of sources offered first when citing (e.g. those on the canvas) */
  preferredSources?: string[];
  /** source and preview side by side, rather than as tabs */
  split?: boolean;
};

type Preview =
  | { state: 'offline' | 'starting' | 'compiling' }
  | { state: 'ok'; pages: string[]; warnings: string[] }
  | { state: 'error'; diagnostics: string; missing: string[] };

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * A Typst document: its source, highlighted, with `@` completing citekeys, compiled as you type by the connector's
 * `typst@1` service into a preview. The sources it cites go along as `/sources.bib`, its assets at their paths.
 * Without the service it is still editable, and shows the last built PDF.
 */
export const TypstEditor = definePerspective<{ sources: Query }, Props, { typst: string }>({
  id: 'typst-editor',
  title: 'Typst',
  data: { sources: { tagsAll: ['source'] } },
  services: { typst: 'typst@1' },
  Component: ({ data, repo, services, document, preferredSources = [], split = false }) => {
    const doc = useNote(document);
    const [draft, setDraft] = useState<string | null>(null);
    const [tab, setTab] = useState<'source' | 'preview'>('source');
    const [tool, setTool] = useState<'cite' | 'image' | null>(null);
    const [building, setBuilding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const view = useRef<EditorView | null>(null);
    const byKey = useMemo(() => new Map(data.sources.flatMap((s) => { const k = str(s, 'citekey'); return k ? [[k, s] as const] : []; })), [data.sources]);
    const sourcesRef = useRef(data.sources);
    useEffect(() => { sourcesRef.current = data.sources; });
    const [extensions] = useState(() => [
      typst_lezer(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      autocompletion({ override: [(ctx: CompletionContext) => citeCompletions(ctx, sourcesRef.current)] }),
    ]);

    const source = doc ? sourceOf(doc) : '';
    const text = draft ?? source;
    const cited = useMemo(() => bib.citedKeys(text).flatMap((k) => { const s = byKey.get(k); return s ? [s] : []; }), [text, byKey]);
    const bibText = useMemo(() => bib.write(cited.map((s) => s.value as Source)), [cited]);
    const assets = useMemo(() => (doc ? assetsOf(doc) : {}), [doc]);
    const preview = useCompile(services.typst, text, assets, bibText);
    const pdf = useBlobUrl(doc ? blob(doc, 'pdf') : undefined);
    const host = doc ? relationships(doc).find((r) => r.label === DOCUMENT_OF)?.target : undefined;
    const hostNote = useNote(host ? repo.keyOf(host) : undefined);

    if (!doc) return <p className="p-8 text-center text-base-content/60">No document <code>{document}</code>.</p>;

    const save = async () => {
      if (draft === null || draft === source) { setDraft(null); return; }
      const current = repo.get(doc.key);
      await repo.putValue(doc.key, withSource(current?.value ?? null, draft, cited.map((s) => s.id)));
      setDraft(null);
    };
    const insert = (snippet: string) => {
      const v = view.current;
      if (v) {
        const { from, to } = v.state.selection.main;
        v.dispatch({ changes: { from, to, insert: snippet }, selection: { anchor: from + snippet.length } });
        v.focus();
      } else setDraft(`${text}${snippet}`);
    };
    const addImage = async (name: string) => {
      const path = `/blobs/${name}`;
      await repo.putValue(doc.key, withAsset(repo.get(doc.key)?.value ?? null, path, name));
      insert(`#image(${JSON.stringify(path)})`);
      setTool(null);
    };
    const upload = async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = await blobName(bytes, file.name.split('.').pop() ?? '');
      await repo.writeBlob(name, bytes);
      await addImage(name);
    };
    const build = async () => {
      if (!services.typst) return;
      setBuilding(true);
      setError(null);
      try {
        await save();
        const r = await services.typst.request('compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: text, assets, bib: bibText, format: 'pdf' }) });
        if (!r.ok) throw new Error(r.status === 422 ? 'the document has errors' : `compile failed (${r.status})`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const name = await blobName(bytes, 'pdf');
        await repo.writeBlob(name, bytes);
        await repo.putValue(doc.key, withPdf(repo.get(doc.key)?.value ?? null, name));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally { setBuilding(false); }
    };
    const images = [...new Set([...(hostNote ? blobs(hostNote) : []), ...blobs(doc)].map((b) => b.target).filter((b) => IMAGE.test(b)))];

    const editor = (
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- saves when focus leaves the editor
      <div className="min-h-0" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void save(); }}>
        <CodeMirrorHost value={text} extensions={extensions} onChange={setDraft} onSave={() => void save()} onView={(v) => { view.current = v; }} />
      </div>
    );
    const shown = <PreviewPane preview={preview} />;
    return (
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {!split && (
            <div role="tablist" className="join mr-1">
              {(['source', 'preview'] as const).map((t) => (
                <button key={t} type="button" role="tab" className={`btn btn-xs join-item ${tab === t ? 'btn-active' : ''}`} onClick={() => setTab(t)}>
                  {t === 'source' ? 'Source' : 'Preview'}
                </button>
              ))}
            </div>
          )}
          <ToolButton title="Cite a source" active={tool === 'cite'} onClick={() => setTool(tool === 'cite' ? null : 'cite')}><Quote className="size-3.5" /></ToolButton>
          <ToolButton title="Insert an image" active={tool === 'image'} onClick={() => setTool(tool === 'image' ? null : 'image')}><Image className="size-3.5" /></ToolButton>
          <button type="button" className="btn btn-xs" disabled={!services.typst || building} onClick={() => void build()}
                  title={services.typst ? 'Build the PDF and keep it with the document' : 'Building needs the connector and its Typst plugin'}>
            {building ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />} Build PDF
          </button>
          {pdf && <a className="link text-xs" href={pdf} target="_blank" rel="noopener">last PDF</a>}
          {draft !== null && draft !== source && <span className="badge badge-xs badge-ghost">unsaved</span>}
          {error && <span className="text-xs text-error">{error}</span>}
        </div>
        {tool === 'cite' && (
          <div className="max-h-72 rounded-box border border-base-300 p-2">
            <SourcePicker autofocus first={[...relationships(doc).filter((r) => r.label === 'cites').map((r) => r.target), ...preferredSources]}
                          onPick={(s) => { insert(citation(str(s, 'citekey') ?? '')); setTool(null); }} />
          </div>
        )}
        {tool === 'image' && (
          <div className="flex flex-wrap items-center gap-2 rounded-box border border-base-300 p-2">
            {images.map((name) => <ImageChoice key={name} name={name} onPick={() => void addImage(name)} />)}
            <label className="btn btn-sm"><Upload className="size-3.5" /> Upload
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            </label>
          </div>
        )}
        {split ? (
          <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-2">{editor}{shown}</div>
        ) : tab === 'source' ? editor : shown}
      </div>
    );
  },
});

function ToolButton({ title, active, onClick, children }: { title: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={`btn btn-xs btn-square ${active ? 'btn-active' : ''}`} title={title} onClick={onClick}>{children}</button>;
}

function ImageChoice({ name, onPick }: { name: string; onPick: () => void }) {
  const url = useBlobUrl(name);
  return (
    <button type="button" className="h-16 w-16 overflow-hidden rounded border border-base-300" title={name} onClick={onPick}>
      {url && <img src={url} alt={name} className="h-full w-full object-cover" />}
    </button>
  );
}

function PreviewPane({ preview }: { preview: Preview }) {
  const status = {
    offline: 'The preview needs the connector, with its Typst plugin.',
    starting: 'The Typst plugin is starting…',
    compiling: 'Compiling…',
  } as const;
  if (preview.state === 'error') {
    return (
      <div className="flex flex-col gap-2">
        {preview.missing.length > 0 && <p className="text-sm text-warning">Not in the connector's folder (yet): {preview.missing.join(', ')}</p>}
        <pre className="overflow-x-auto rounded-box bg-base-200 p-3 text-xs text-error">{preview.diagnostics}</pre>
      </div>
    );
  }
  if (preview.state !== 'ok') return <p className="p-4 text-sm text-base-content/60">{status[preview.state]}</p>;
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
      {preview.warnings.map((w, i) => <pre key={i} className="overflow-x-auto text-xs text-warning">{w}</pre>)}
      {preview.pages.map((svg, i) => (
        <img key={i} alt={`page ${i + 1}`} className="w-full rounded border border-base-300 bg-white shadow-sm"
             src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
      ))}
    </div>
  );
}

/** The document compiled to SVG pages, 500 ms after the last change; answers to older texts are dropped. */
function useCompile(service: ServiceClient | undefined, source: string, assets: Record<string, string>, bibText: string): Preview {
  const [preview, setPreview] = useState<Preview>({ state: service ? 'compiling' : 'offline' });
  const seq = useRef(0);
  const assetsKey = JSON.stringify(assets);
  // a new client comes with every render; the address is what matters
  const address = service ? `${service.baseUrl}/${service.id}` : null;
  const client = useRef(service);
  useEffect(() => { client.current = service; });
  useEffect(() => {
    const service = client.current;
    if (!address || !service) { setPreview({ state: 'offline' }); return; }
    const mine = ++seq.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await service.request('compile', {
          method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source, assets: JSON.parse(assetsKey) as Record<string, string>, bib: bibText, format: 'svg' }),
        });
        if (mine !== seq.current) return;
        if (r.status === 503) return setPreview({ state: 'starting' });
        const body = await r.json() as { pages?: string[]; warnings?: string[]; diagnostics?: string; missing?: string[]; error?: string };
        if (mine !== seq.current) return;
        if (r.ok && body.pages) setPreview({ state: 'ok', pages: body.pages, warnings: body.warnings ?? [] });
        else setPreview({ state: 'error', diagnostics: body.diagnostics ?? body.error ?? `compile failed (${r.status})`, missing: body.missing ?? [] });
      } catch (e) {
        if (mine === seq.current && !controller.signal.aborted) setPreview({ state: 'error', diagnostics: e instanceof Error ? e.message : String(e), missing: [] });
      }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [address, source, assetsKey, bibText]);
  return preview;
}

/** `@` completes citekeys, by key, title, names or year. */
function citeCompletions(ctx: CompletionContext, sources: IndexedNote[]) {
  const word = ctx.matchBefore(/@[\p{L}\p{N}_\-.:]*/u);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return {
    from: word.from,
    options: sources.flatMap((s) => {
      const key = str(s, 'citekey');
      return key ? [{ label: citation(key), detail: sourceSummary(s), apply: citation(key) }] : [];
    }),
    validFor: /^@[\p{L}\p{N}_\-.:]*$/u,
  };
}

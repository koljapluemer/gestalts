import { useState } from 'react';
import { FilePlus2, FileType, PanelLeft } from 'lucide-react';
import { Slot, definePane, fold, noteLabel, useNote, useQuery, useRepo, type IndexedNote } from '@gestalts/sdk';
import { SearchLayout, useUrlList } from '@gestalts/kit';
import { TypstEditor } from './TypstEditor';
import { TypstHosts } from './TypstHosts';
import { createTypstDocument, documentsOf } from './typstDocument';

/** Old `canvas@1` notes, until they're folded into their hosts. */
const OLD_CANVASES = { tagsAll: ['canvas'] };

/** The notes on a host's canvas, read from the notes: the canvas itself is the canvas plugin's. */
const canvasLinksOf = (host: IndexedNote, old: IndexedNote[]) => fold.canvasLinks(fold.readCanvas(host, fold.attached(old, host.id, 'canvas')).value);

/**
 * A note's canvas beside its Typst document, for writing from what's gathered on the canvas. From the search any
 * note opens here, given a new Typst document first unless it has one. The canvas is whatever view the installed
 * plugins offer for `canvas@2` (the `note-view` slot); without one, add notes to the canvas in the Canvas pane.
 */
function Canvas2TypPaneView() {
  const repo = useRepo();
  const [[host] = [], setHost] = useUrlList('host');
  const [[picked] = [], setPicked] = useUrlList('doc');
  const [listing, setListing] = useState(!host);
  const [side, setSide] = useState<'canvas' | 'typst'>('canvas');
  const hostNote = useNote(host);
  const documents = useQuery({ tagsAll: ['typst'] });
  const canvases = useQuery(OLD_CANVASES);
  const docs = hostNote ? documentsOf(documents, hostNote.id) : [];
  const doc = docs.find((d) => d.key === picked) ?? docs[0];
  // sources on the canvas are offered first when citing
  const onCanvas = hostNote ? canvasLinksOf(hostNote, canvases) : [];

  const show = (key: string) => { setHost([key]); setPicked([]); setListing(false); };
  const openHere = async (key: string) => {
    const n = repo.get(key);
    if (!n) return;
    if (!documentsOf(documents, n.id).length) await createTypstDocument(repo, n);
    show(key);
  };

  return (
    <SearchLayout openKeys={host ? [host] : []} actions={[
      { icon: <FileType className="size-3.5" />, title: 'Open as canvas + Typst (a new Typst document unless it has one)', run: (k) => void openHere(k) },
    ]}>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <aside className={`min-h-0 overflow-y-auto border-base-300 md:w-56 md:border-r ${listing ? '' : 'max-md:hidden'}`}>
          <TypstHosts current={host} onOpen={show} />
        </aside>
        {hostNote ? (
          <section className={`flex min-h-0 flex-1 flex-col ${listing ? 'max-md:hidden' : ''}`}>
            <div className="flex flex-wrap items-center gap-2 border-b border-base-300 px-2 py-1">
              <button type="button" className="btn btn-xs md:hidden" onClick={() => setListing(true)}><PanelLeft className="size-3.5" /> Notes</button>
              <span className="truncate font-semibold">{noteLabel(hostNote)}</span>
              <div role="tablist" className="join xl:hidden">
                {(['canvas', 'typst'] as const).map((s) => (
                  <button key={s} type="button" role="tab" className={`btn btn-xs join-item ${side === s ? 'btn-active' : ''}`} onClick={() => setSide(s)}>
                    {s === 'canvas' ? 'Canvas' : 'Typst'}
                  </button>
                ))}
              </div>
              {docs.length > 1 && (
                <select className="select select-xs" value={doc?.key} onChange={(e) => setPicked([e.target.value])}>
                  {docs.map((d) => <option key={d.key} value={d.key}>{noteLabel(d)}</option>)}
                </select>
              )}
            </div>
            {/* both stay mounted, so switching sides keeps the canvas and unsaved Typst edits */}
            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-2">
              <div className={`min-h-0 ${side === 'canvas' ? '' : 'max-xl:hidden'}`}>
                <Slot name="note-view" gestalt="canvas@2" noteKey={hostNote.key}
                      fallback={<p className="p-8 text-center text-base-content/60">No canvas view: install the Canvas plugin.</p>} />
              </div>
              <div className={`min-h-0 overflow-y-auto border-base-300 p-2 xl:border-l ${side === 'typst' ? '' : 'max-xl:hidden'}`}>
                {doc
                  ? <TypstEditor key={doc.key} document={doc.key} preferredSources={onCanvas} />
                  : (
                    <button type="button" className="btn btn-sm" onClick={() => void openHere(hostNote.key)}>
                      <FilePlus2 className="size-4" /> New Typst document
                    </button>
                  )}
              </div>
            </div>
          </section>
        ) : (
          <p className={`flex-1 p-8 text-center text-base-content/60 ${listing ? 'max-md:hidden' : ''}`}>Pick a note, or open any from the search.</p>
        )}
      </div>
    </SearchLayout>
  );
}

export const Canvas2TypPane = definePane({ title: 'Canvas2Typ', Component: Canvas2TypPaneView });

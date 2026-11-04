import { useState } from 'react';
import { PanelLeft, Shapes, SquarePlus } from 'lucide-react';
import { definePane, useHost } from '@gestalts/sdk';
import { SearchLayout, useUrlList } from '@gestalts/kit';
import { Canvas } from './Canvas';
import { CanvasList } from './CanvasList';

/** The notes with a canvas beside the one open; from the search any note opens as a canvas, or joins the one open. */
function CanvasPaneView() {
  const [[host] = [], setHost] = useUrlList('canvas');
  const [add, setAdd] = useState<{ key: string; seq: number } | null>(null);
  const [listing, setListing] = useState(!host);
  const edit = useHost().openNote;
  const show = (key: string) => { setHost([key]); setListing(false); };
  return (
    <SearchLayout openKeys={host ? [host] : []} actions={[
      { icon: <Shapes className="size-3.5" />, title: 'Open as canvas', run: show },
      ...(host ? [{ icon: <SquarePlus className="size-3.5" />, title: 'Add to this canvas', run: (key: string) => setAdd({ key, seq: Date.now() }) }] : []),
    ]}>
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <aside className={`min-h-0 overflow-y-auto border-base-300 md:w-60 md:border-r ${listing ? '' : 'max-md:hidden'}`}>
          <CanvasList current={host} onOpen={show} />
        </aside>
        <section className={`relative min-h-0 flex-1 ${listing ? 'max-md:hidden' : ''}`}>
          <button type="button" className="btn btn-xs absolute right-2 top-2 z-10 md:hidden" onClick={() => setListing(true)}><PanelLeft className="size-3.5" /> Canvases</button>
          {host
            ? <Canvas host={host} onOpen={edit} add={add} />
            : <p className="p-8 text-center text-base-content/60">Pick a canvas, or open any note as one from the search.</p>}
        </section>
      </div>
    </SearchLayout>
  );
}

export const CanvasPane = definePane({ title: 'Canvas', Component: CanvasPaneView });

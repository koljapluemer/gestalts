import { useState } from 'react';
import { registry } from 'virtual:gestalts-plugins/home';
import { SingleView } from '@gestalts/host';
import css from '../app.css?inline';
import { WithHome } from '../home';
import { SyncMenu } from '../notes/Notes';
import { Areas } from '../router';

/**
 * Loops for learning: its learning views (plugins tagged `learning`), one at a time. Decks are read-only; what the
 * learner does stays in this browser (the home store) unless they sync it.
 */
const LOOPS = ['flashcards', 'alphabet-pronunciation-trainer', 'phrasebook', 'math-drills', 'world-map', 'flags-practice', 'vietnamese-typing-practice'];
const VIEWS = registry.plugins.filter((p) => LOOPS.includes(p.manifest.id) && p.manifest.tags?.includes('learning'));
const LAST_VIEW = 'loops:view';

function lastView(): string | undefined {
  try {
    const v = localStorage.getItem(LAST_VIEW);
    if (v && VIEWS.some((p) => p.manifest.id === v)) return v;
  } catch { /* no storage: the first view */ }
  return VIEWS[0]?.manifest.id;
}

export function Learn() {
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="font-semibold">Loops for learning</span>
      </header>
      <div className="min-h-0 flex-1"><WithHome>{() => <Views />}</WithHome></div>
    </div>
  );
}

function Views() {
  const [view, setView] = useState(lastView);
  const choose = (v: string) => {
    setView(v);
    try { localStorage.setItem(LAST_VIEW, v); } catch { /* not remembered */ }
  };
  return (
    <div className="flex h-full flex-col bg-base-200">
      <header className="navbar min-h-0 gap-2 bg-base-100 px-4 py-1 shadow-sm">
        <div role="tablist" className="tabs tabs-border flex-1 overflow-x-auto">
          {VIEWS.length > 1 && VIEWS.map((p) => (
            <button key={p.manifest.id} type="button" role="tab" aria-selected={p.manifest.id === view} className={`tab ${p.manifest.id === view ? 'tab-active' : ''}`} onClick={() => choose(p.manifest.id)}>
              {p.manifest.title}
            </button>
          ))}
        </div>
        <SyncMenu />
      </header>
      <main className="min-h-0 flex-1">
        {view && <SingleView key={view} registry={registry} css={css} view={view} />}
      </main>
      <footer className="px-4 py-1 text-center text-xs text-base-content/50">Your progress is stored only in this browser, unless you sync it. Pronunciation generated with espeak-ng.</footer>
    </div>
  );
}

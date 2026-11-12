import { useState } from 'react';
import { Learn } from './app/Learn';
import { Make } from './workshop/Make';
import { initialMode, rememberMode, type Mode } from './mode';

export function App() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const choose = (next: Mode) => {
    setMode(next);
    rememberMode(next);
  };
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <span className="font-semibold">Loops for learning</span>
        <div role="tablist" aria-label="Product mode" className="tabs tabs-box tabs-sm">
          <button type="button" role="tab" aria-selected={mode === 'learn'} className={`tab ${mode === 'learn' ? 'tab-active' : ''}`} onClick={() => choose('learn')}>Learn</button>
          <button type="button" role="tab" aria-selected={mode === 'make'} className={`tab ${mode === 'make' ? 'tab-active' : ''}`} onClick={() => choose('make')}>Make</button>
        </div>
      </header>
      <div className="min-h-0 flex-1">{mode === 'learn' ? <Learn /> : <Make />}</div>
    </div>
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Make } from './workshop/Make';
import './app.css';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <span className="font-semibold">vizint workshop</span>
      </header>
      <div className="min-h-0 flex-1"><Make /></div>
    </div>
  </StrictMode>,
);

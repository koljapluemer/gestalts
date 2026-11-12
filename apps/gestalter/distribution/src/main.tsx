import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('app')!).render(<StrictMode><App /></StrictMode>);

// the built site opens offline too (public/sw.js); not in development, where Vite serves fresh files
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e: unknown) => console.warn('gestalter: no offline copy:', e));
}

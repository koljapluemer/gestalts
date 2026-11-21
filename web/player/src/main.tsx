import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from './Player';
import './app.css';

createRoot(document.getElementById('app')!).render(<StrictMode><Player /></StrictMode>);

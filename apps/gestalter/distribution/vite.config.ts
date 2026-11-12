import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

/**
 * A static website on the gestalts-node on this computer, which it reaches at `VITE_GESTALTS_NODE` (default
 * `http://127.0.0.1:7717`; `mise run gestalter:dev` points it at a dev node).
 */
export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173 },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: './',
});

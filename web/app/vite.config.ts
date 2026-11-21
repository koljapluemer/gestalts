import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

// The teacher area and its API share an origin (cookies, no CORS): in dev, /api goes to `gestalts-teacher serve`.
const api = process.env.VITE_TEACHER_API ?? 'http://127.0.0.1:7740';

export default defineConfig({
  server: { port: 5173, proxy: { '/api': api } },
  preview: { port: 4173, proxy: { '/api': api } },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  // the areas are paths (/notes, /learn, …), so everything is from the root
  base: '/',
});

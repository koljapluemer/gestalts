import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

// The app and its API share an origin (cookies, no CORS): in dev, /api goes to `gestalts-teacher serve` (:7740).
const api = process.env.VITE_TEACHER_API ?? 'http://127.0.0.1:7740';

export default defineConfig({
  server: { port: 5178, proxy: { '/api': api } },
  preview: { port: 4178, proxy: { '/api': api } },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: '/',
});

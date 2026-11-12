import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

export default defineConfig({
  server: { port: 5174 },
  preview: { port: 4174 },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: './',
});

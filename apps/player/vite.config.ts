import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

// The lesson domain serves this build under /runtime/<version>/, with a <base> to there, for every /l/<lesson>. In dev,
// what the lesson domain answers comes from the teacher server (VITE_LESSONS, :7741).
const lessons = process.env.VITE_LESSONS ?? 'http://127.0.0.1:7741';

export default defineConfig({
  server: { port: 5177, proxy: { '^/l/[^/]+/current$': lessons, '/lessons/': lessons, '/npm/': lessons } },
  preview: { port: 4177 },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: './',
});

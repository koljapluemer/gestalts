import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

/** `tauri android dev` sets this to an address the phone reaches this machine at. */
const host = process.env.TAURI_DEV_HOST;
/** `mise run android-dev` picks these. */
const port = Number(process.env.GESTALTER_PAGE_PORT ?? 5174);
const hmrPort = Number(process.env.GESTALTER_HMR_PORT ?? port + 1);

export default defineConfig({
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: hmrPort } : undefined,
  },
  // the app's IPC, from the client and the barcode scanner alike: one copy
  resolve: { dedupe: ['@tauri-apps/api'] },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: './',
});

import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The node whose settings these are (`mise run node:dev` starts one, and says where). */
const NODE = process.env.GESTALTS_NODE ?? 'http://127.0.0.1:7717';

/**
 * The node serves this page itself, so it may use `/control/*`. In development Vite serves it and proxies the node's
 * API, telling the node the page is its own.
 */
const toNode: ProxyOptions = {
  target: NODE,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', NODE); });
  },
};

export default defineConfig({
  server: { port: 5176, proxy: Object.fromEntries(['/health', '/llm', '/control'].map((p) => [p, toNode])) },
  plugins: [react(), tailwindcss()],
  base: './',
});

import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

/** The desktop app's node (`mise run dev` starts it, and says where). */
const NODE = process.env.GESTALTER_NODE ?? 'http://127.0.0.1:7717';

/**
 * In development the node's API is proxied, so the page talks to it at its own origin, as it does when the desktop
 * app serves it. The node lets only pages it served use `/control/*`: tell it this one is.
 */
const toNode: ProxyOptions = {
  target: NODE,
  changeOrigin: true,
  ws: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', NODE); });
    proxy.on('proxyReqWs', (req) => { req.setHeader('origin', NODE); });
  },
};

export default defineConfig({
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/health', '/events', '/ymls', '/sync', '/blobs', '/plugins', '/services', '/net', '/llm', '/control'].map((p) => [p, toNode])),
  },
  preview: { port: 4173 },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: './',
});

/**
 * What every build of a viz shares, wherever it runs (`build.ts` in Node, `@gestalts/check` in the page and in Node):
 * the loaders, the entries, the `?pixels` module and the page around the bundle. No Node, no DOM.
 */

/** A built page may be at most this big. */
export const MAX_BYTES = 5 * 1024 * 1024;

/** esbuild's loaders for what a viz may import besides code. */
export const LOADERS = {
  '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl',
  '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl',
  '.csv': 'text', '.tsv': 'text', '.txt': 'text', '.md': 'text', '.geojson': 'json',
} as const;

export const TARGET = 'es2022';

/** The entry of the page: the viz, mounted. */
export const pageEntry = (vizPath: string) =>
  `import def from ${JSON.stringify(vizPath)};\nimport { mount } from '@gestalts/viz/mount';\nmount(def);\n`;

/** The entry of the checks: an ES module exporting `results`. */
export const checksEntry = (vizPath: string) =>
  `import def from ${JSON.stringify(vizPath)};\nimport { runChecks } from '@gestalts/viz';\nexport const results = runChecks(def);\n`;

export type Pixels = { width: number; height: number; data: Uint8Array };

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The module a `files/<name>?pixels` import becomes: the decoded RGBA pixels, synchronously. */
export const pixelsModule = (img: Pixels) =>
  `const s = atob(${JSON.stringify(base64(img.data))}); const d = new Uint8ClampedArray(s.length);
for (let i = 0; i < s.length; i++) d[i] = s.charCodeAt(i);
export default { width: ${img.width}, height: ${img.height}, data: d };`;

const inline = (code: string, tag: string) => code.replaceAll(`</${tag}`, `<\\/${tag}`);

/** The built page: one file, offline. Throws when it's bigger than `MAX_BYTES`. */
export function pageHtml(js: string, css: string): string {
  const html = `<!doctype html>
<html lang="en" data-gestalts-viz>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${inline(css, 'style')}</style>
</head>
<body>
<div id="viz"></div>
<script>${inline(js, 'script')}</script>
</body>
</html>
`;
  const size = new TextEncoder().encode(html).length;
  if (size > MAX_BYTES) throw new Error(`the page is ${size} bytes, more than ${MAX_BYTES}: reduce what it imports`);
  return html;
}

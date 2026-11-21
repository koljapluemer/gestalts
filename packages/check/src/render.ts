/**
 * A built viz rendered in the page, the way the old headless-browser check did: in sandboxed frames (no
 * same-origin, every request blocked) at 360 and 1000 px, light and dark. Reports uncaught and console errors,
 * blocked requests, a runtime that didn't mount, the viz's own error, empty renders and horizontal overflow, and
 * rasterizes each frame (canvases and overlays) to a PNG; plus the still, 800 px wide, light, cut to 5:3 at most.
 */
import htmlToImage from 'html-to-image/dist/html-to-image.js?raw';
import type { Render, Shot } from './index.ts';

const VIEWS = [[360, 'light'], [1000, 'light'], [1000, 'dark']] as const;
const SETTLE_MS = 800;
const MIN_HEIGHT = 8;
const TIMEOUT_MS = 20_000;

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

type Probe = { problems: string[]; height: number; png?: string; failed?: string };

/** Runs inside the frame: collects what goes wrong, and on the parent's word measures and rasterizes. */
const PROBE = `
(() => {
  const problems = [];
  // what rasterizing does itself isn't the viz's
  let probing = false;
  addEventListener('error', (e) => problems.push('uncaught: ' + (e.message || e.error)));
  addEventListener('unhandledrejection', (e) => problems.push('uncaught: ' + ((e.reason && e.reason.message) || e.reason)));
  addEventListener('securitypolicyviolation', (e) => probing || problems.push('blocked request (a viz must work offline): ' + e.blockedURI));
  const error = console.error.bind(console);
  console.error = (...a) => { problems.push('console.error: ' + a.map(String).join(' ')); error(...a); };
  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.type !== 'gestalts-probe') return;
    const { width, clip, minHeight } = e.data;
    await new Promise((r) => setTimeout(r, ${SETTLE_MS}));
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    const used = document.documentElement.scrollWidth;
    if (!document.querySelector('.viz-root')) problems.push("the runtime didn't mount: no .viz-root");
    const err = document.querySelector('.viz-error');
    if (err && !err.hidden && err.textContent) problems.push('the viz showed an error: ' + err.textContent);
    if (height < minHeight) problems.push('the page is ' + height + 'px high: nothing visible was rendered');
    if (used > width + 1) problems.push('horizontal overflow at ' + width + 'px wide: content is ' + used + 'px wide');
    let png, failed;
    probing = true;
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const h = clip ? Math.min(Math.max(height, 1), clip) : Math.max(height, 1);
      png = await htmlToImage.toPng(document.documentElement, { width, height: h, backgroundColor: bg === 'rgba(0, 0, 0, 0)' ? 'white' : bg, pixelRatio: 1, skipFonts: true });
    } catch (x) {
      failed = String(x && x.message || x);
    }
    parent.postMessage({ type: 'gestalts-probe-result', problems, height, png, failed }, '*');
  });
})();
`;

function withProbe(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${htmlToImage}</script><script>${PROBE}</script>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>${head}`) : `${head}${html}`;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const pngBytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));

/** One frame of `html` at `width`, in `mode`; resolves with what the probe found. */
function frame(html: string, width: number, mode: 'light' | 'dark', clip?: number): Promise<Probe> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    Object.assign(iframe.style, { position: 'fixed', left: '-20000px', top: '0', width: `${width}px`, height: '600px', border: '0', visibility: 'hidden' });
    const done = (p: Probe) => {
      removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
      resolve(p);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow || !e.data || e.data.type !== 'gestalts-probe-result') return;
      done(e.data as Probe);
    };
    const timer = setTimeout(() => done({ problems: [`the page didn't answer within ${TIMEOUT_MS / 1000} s (an endless loop?)`], height: 0 }), TIMEOUT_MS);
    addEventListener('message', onMessage);
    iframe.addEventListener('load', () => {
      const w = iframe.contentWindow;
      w?.postMessage({ type: 'theme', mode }, '*');
      w?.postMessage({ type: 'gestalts-probe', width, clip, minHeight: MIN_HEIGHT }, '*');
    }, { once: true });
    iframe.srcdoc = withProbe(html);
    document.body.append(iframe);
  });
}

export async function render(html: string): Promise<Render> {
  const problems: string[] = [];
  const shots: Shot[] = [];
  for (const [width, mode] of VIEWS) {
    const p = await frame(html, width, mode);
    for (const m of new Set(p.problems)) problems.push(`${width}px ${mode}: ${m}`);
    if (p.png) shots.push({ name: `check-${width}-${mode}.png`, png: pngBytes(p.png) });
  }
  const s = await frame(html, 800, 'light', 480);
  return { problems, shots, still: s.png ? pngBytes(s.png) : undefined };
}

/** Runs an ES module exporting `results` in a sandboxed frame, where it reaches nothing. */
export function runInFrame<T>(js: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    const done = (f: () => void) => { removeEventListener('message', onMessage); clearTimeout(timer); iframe.remove(); f(); };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow || !e.data || e.data.type !== 'gestalts-run') return;
      const d = e.data as { ok: boolean; results?: T; error?: string };
      done(() => (d.ok ? resolve(d.results as T) : reject(new Error(d.error))));
    };
    const timer = setTimeout(() => done(() => reject(new Error(`the checks didn't finish within ${TIMEOUT_MS / 1000} s (an endless loop?)`))), TIMEOUT_MS);
    addEventListener('message', onMessage);
    const url = `data:text/javascript;base64,${base64(new TextEncoder().encode(js))}`;
    iframe.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:"><script type="module">
try { const m = await import(${JSON.stringify(url)}); parent.postMessage({ type: 'gestalts-run', ok: true, results: JSON.parse(JSON.stringify(m.results)) }, '*'); }
catch (e) { parent.postMessage({ type: 'gestalts-run', ok: false, error: String(e && e.stack || e) }, '*'); }
</script>`;
    document.body.append(iframe);
  });
}

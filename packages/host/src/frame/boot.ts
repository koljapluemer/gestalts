/**
 * The page inside a view's frame. It has an opaque origin, so it loads nothing from the app: the runtime and the view
 * arrive over the message port, and an import map built here points every import at modules made here, and each npm
 * package at the URL it was given (esm.sh, unpinned, when none was).
 */
const script = String.raw`
addEventListener('message', async (first) => {
  if (first.source !== parent || !first.ports[0]) return;
  const port = first.ports[0];
  const stage = (name) => port.postMessage({ type: 'stage', stage: name });
  const fail = (e) => (console.error('view failed to start:', e), port.postMessage({ type: 'error', error: { kind: 'error', message: String(e && e.message || e), stack: e && e.stack, at: new Date().toISOString() } }));
  try {
    stage('received');
    const { runtime, css, js, npm, npmUrls, tailwind, init } = first.data;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    (0, eval)(runtime);
    const R = globalThis.__gestaltsRuntime;
    stage('runtime evaluated');
    const blob = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const imports = {};
    for (const [name, m] of Object.entries(R.modules)) {
      const access = 'globalThis.__gestaltsRuntime.modules[' + JSON.stringify(name) + ']';
      const names = Object.keys(m).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
      imports[name] = blob('const m = ' + access + ';\nexport default m.default === undefined ? m : m.default;\n' + names.map((k) => 'export const ' + k + ' = m.' + k + ';').join('\n'));
    }
    for (const name of npm) imports[name] = (npmUrls && npmUrls[name]) || 'https://esm.sh/' + name + '?external=react,react-dom';
    if (tailwind) {
      const tw = document.createElement('script');
      tw.textContent = tailwind;
      document.head.append(tw);
    }
    const map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({ imports });
    document.head.append(map);
    stage('import map ready');
    globalThis.__gestaltsStart = (view) => { stage('module imported'); R.mount(view, port, init); stage('mounted'); };
    globalThis.__gestaltsFail = fail;
    const run = document.createElement('script');
    run.type = 'module';
    run.textContent = 'try { const v = await import(' + JSON.stringify(blob(js)) + '); globalThis.__gestaltsStart(v.default); } catch (e) { globalThis.__gestaltsFail(e); }';
    document.head.append(run);
  } catch (e) { fail(e); }
});
parent.postMessage('gestalts:ready', '*');
`;

/** The frame's page; with `csp`, under that Content-Security-Policy. */
export function bootHtml(csp?: string): string {
  const policy = csp ? `<meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${policy}<meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="view" class="h-dvh"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

export const BOOT_HTML = bootHtml();

/**
 * The policy for a view nobody vetted (a teacher's lesson, a draft): it reaches no server. Nothing it reads or is told
 * can leave by `fetch`, a WebSocket, a form or an image URL; scripts come only from the runtime, the frame's own blobs
 * and `scripts` (where its npm packages are); images, media and fonts only from blobs, data URLs and `media`. A
 * request it isn't allowed shows as an error in the console, so the preview shows it while it's being made.
 */
export function closedCsp({ scripts = [], media = [] }: { scripts?: string[]; media?: string[] } = {}): string {
  const list = (xs: string[]) => xs.map((x) => ` ${x}`).join('');
  return [
    "default-src 'none'",
    // the boot script, the import map and Tailwind are inline; the runtime is eval'd
    `script-src 'unsafe-inline' 'unsafe-eval' blob:${list(scripts)}`,
    "style-src 'unsafe-inline'",
    `img-src blob: data:${list(media)}`,
    `media-src blob: data:${list(media)}`,
    `font-src blob: data:${list([...scripts, ...media])}`,
    'worker-src blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

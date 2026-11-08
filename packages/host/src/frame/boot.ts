/**
 * The page inside a view's frame. It has an opaque origin, so it loads nothing from the app: the runtime and the view
 * arrive over the message port, and an import map built here points every import at modules made here.
 */
const script = String.raw`
addEventListener('message', async (first) => {
  if (first.source !== parent || !first.ports[0]) return;
  const port = first.ports[0];
  const fail = (e) => port.postMessage({ type: 'error', error: { kind: 'error', message: String(e && e.message || e), stack: e && e.stack, at: new Date().toISOString() } });
  try {
    const { runtime, css, js, npm, tailwind, init } = first.data;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    (0, eval)(runtime);
    const R = globalThis.__gestaltsRuntime;
    const blob = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const imports = {};
    for (const [name, m] of Object.entries(R.modules)) {
      const access = 'globalThis.__gestaltsRuntime.modules[' + JSON.stringify(name) + ']';
      const names = Object.keys(m).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
      imports[name] = blob('const m = ' + access + ';\nexport default m.default === undefined ? m : m.default;\n' + names.map((k) => 'export const ' + k + ' = m.' + k + ';').join('\n'));
    }
    for (const name of npm) imports[name] = 'https://esm.sh/' + name + '?external=react,react-dom';
    if (tailwind) {
      const tw = document.createElement('script');
      tw.textContent = tailwind;
      document.head.append(tw);
    }
    const map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({ imports });
    document.head.append(map);
    globalThis.__gestaltsStart = (view) => R.mount(view, port, init);
    globalThis.__gestaltsFail = fail;
    const run = document.createElement('script');
    run.type = 'module';
    run.textContent = 'try { const v = await import(' + JSON.stringify(blob(js)) + '); globalThis.__gestaltsStart(v.default); } catch (e) { globalThis.__gestaltsFail(e); }';
    document.head.append(run);
  } catch (e) { fail(e); }
});
parent.postMessage('gestalts:ready', '*');
`;

export const BOOT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="view" class="h-dvh"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;

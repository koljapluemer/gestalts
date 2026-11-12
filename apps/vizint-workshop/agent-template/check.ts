// Checks the viz in this folder, the way the workshop does: typecheck, its checks, the build, and a render in a
// headless browser at 360 and 1000 px, light and dark, offline. Writes dist/index.html, still.png and the
// check-<width>-<theme>.png screenshots. Exits non-zero on any failure.
//
//   node check.ts               everything
//   node check.ts --no-browser  without the browser (where there is none)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const here = process.cwd();
// the workshop says where @gestalts/viz is; in the repo it's next to this template
const pkg = resolve(process.env.VIZ_PACKAGE ?? join(import.meta.dirname, '../../../packages/viz'));
const repo = resolve(pkg, '../..');
const browser = !process.argv.includes('--no-browser') && process.env.VIZ_BROWSER !== '0';
let failed = false;
const fail = (what: string, detail: string) => { failed = true; console.log(`FAIL ${what}\n${detail.trim().replace(/^/gm, '     ')}`); };

await writeFile(join(here, 'tsconfig.json'), `${JSON.stringify({
  compilerOptions: {
    target: 'ES2023', lib: ['ES2024', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', strict: true,
    noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true, allowImportingTsExtensions: true, types: [],
    paths: { '@gestalts/viz': [join(pkg, 'src/index.ts')], '@gestalts/viz/*': [join(pkg, 'src/*.ts')] },
  },
  files: ['viz.ts', join(pkg, 'client.d.ts')],
}, null, 2)}\n`);

const tsc = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: here, encoding: 'utf8' });
if (tsc.status !== 0) fail('typecheck', `${tsc.stdout}${tsc.stderr}` || `tsc exited with ${tsc.status}`);
else console.log('ok   typecheck');

const { buildPage, runVizChecks } = await import(join(pkg, 'build/build.ts')) as typeof import('../../../packages/viz/build/build.ts');
try {
  for (const c of await runVizChecks(here)) {
    if (c.ok) console.log(`ok   check: ${c.name}`);
    else fail(`check: ${c.name}`, c.message ?? '');
  }
} catch (e) {
  fail('checks', e instanceof Error ? e.message : String(e));
}

let built = false;
try {
  const html = await buildPage(here);
  await mkdir(join(here, 'dist'), { recursive: true });
  await writeFile(join(here, 'dist/index.html'), html);
  console.log(`ok   build: dist/index.html, ${Math.round(Buffer.byteLength(html) / 1024)} KB`);
  built = true;
} catch (e) {
  const errors = (e as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors;
  fail('build', errors?.length ? errors.map((x) => `${x.location ? `${x.location.file}:${x.location.line}: ` : ''}${x.text}`).join('\n') : String(e));
}

if (built && browser) {
  const script = join(import.meta.dirname, 'check.py');
  if (!existsSync(script)) fail('browser', `${script} is missing`);
  else {
    const r = spawnSync('uv', ['run', '--quiet', '--script', script, 'dist/index.html'], { cwd: here, encoding: 'utf8' });
    if (r.error) fail('browser', `cannot run uv: ${r.error.message}`);
    else if (r.status !== 0) fail('browser', `${r.stdout}${r.stderr}`);
    else console.log(r.stdout.trim());
  }
}

console.log(failed ? 'FAILED' : 'passed');
process.exitCode = failed ? 1 : 0;

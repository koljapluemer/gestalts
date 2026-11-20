// `node check.ts`: what the workshop checks before it shows view.tsx (the same compile), plus its types, view.json, and
// the draft's own gestalts (gestalts/) and data (data/). Exit code 0 when all is well. The app checks the ymls again
// when it saves them, and refuses what isn't valid.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { compile } from '@gestalts/view/compile';
import { parse } from 'yaml';

let failed = false;
const fail = (msg: string) => { failed = true; console.log(`✗ ${msg}`); };

/** The gestalts the app has, as the workshop sent them; the draft's own come from gestalts/. */
const APP: string[] = (() => { try { return JSON.parse(readFileSync('.workshop/gestalts.json', 'utf8')) as string[]; } catch { return []; } })();
const TYPES = ['any', 'string', 'text', 'number', 'integer', 'bool', 'date', 'partial_date', 'datetime', 'url', 'string_list', 'list', 'map', 'blob', 'ref', 'ref_list', 'ref_map', 'relationships', 'blobs'];
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yml')).sort() : []);
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
let pkg = '';
try { pkg = String((JSON.parse(readFileSync('view.json', 'utf8')) as { package?: unknown }).package ?? ''); } catch { /* reported below */ }

/** A field rule's mistakes, as the core would find them (its type, and keys only some types take). */
function checkRule(path: string, r: unknown) {
  if (!isMap(r)) return fail(`${path}: a rule is a map, like { type: string, required: true }`);
  const type = r.type ?? 'any';
  if (typeof type !== 'string' || !TYPES.includes(type)) return fail(`${path}: type must be one of ${TYPES.join(', ')}`);
  if (r.fields !== undefined && type !== 'map') fail(`${path}: \`fields\` needs type: map`);
  if (r.items !== undefined && type !== 'list') fail(`${path}: \`items\` needs type: list`);
  if (isMap(r.fields)) for (const [k, sub] of Object.entries(r.fields)) checkRule(`${path}.${k}`, sub);
  if (r.items !== undefined) checkRule(`${path}[]`, r.items);
  if (r.values !== undefined) checkRule(`${path}{}`, r.values);
}

const own: string[] = [];
for (const f of files('gestalts')) {
  const m = /^([a-z0-9-]+)@([1-9][0-9]*)\.yml$/.exec(f);
  if (!m) { fail(`gestalts/${f}: name it <name>@<version>.yml, the name in lowercase letters, digits and -`); continue; }
  own.push(`${pkg}/${m[1]}@${m[2]}`);
  try {
    const d = parse(readFileSync(`gestalts/${f}`, 'utf8')) as unknown;
    if (!isMap(d)) { fail(`gestalts/${f}: must be a map with \`fields\``); continue; }
    for (const k of Object.keys(d)) if (!['description', 'fields', 'merge'].includes(k)) fail(`gestalts/${f}: \`${k}\` isn't part of a definition (description, fields, merge)`);
    if (!isMap(d.fields)) fail(`gestalts/${f}: \`fields\` must be a map of field rules`);
    else for (const [k, r] of Object.entries(d.fields)) {
      if (k === 'id' || k === 'gestalt') fail(`gestalts/${f}: \`${k}\` belongs to every yml and can't be declared`);
      checkRule(`gestalts/${f}: ${k}`, r);
    }
  } catch (e) { fail(`gestalts/${f}: ${(e as Error).message}`); }
}
if (own.length) console.log(`✓ its own gestalts: ${own.join(', ')}`);
const CORE = [...APP, ...own];

let data = 0;
for (const f of files('data')) {
  try {
    const d = parse(readFileSync(`data/${f}`, 'utf8')) as unknown;
    const g = isMap(d) ? d.gestalt : undefined;
    if (typeof g !== 'string') fail(`data/${f}: needs \`gestalt: name@N\``);
    else if (!CORE.includes(g)) fail(`data/${f}: no gestalt ${g} here`);
    else data++;
  } catch (e) { fail(`data/${f}: ${(e as Error).message}`); }
}
if (data) console.log(`✓ ${data} yml(s) in data/ name a gestalt here`);

let npm: string[] = [];
if (!existsSync('view.tsx')) {
  fail('view.tsx is missing');
} else {
  const r = compile(readFileSync('view.tsx', 'utf8'));
  if (r.ok) {
    npm = r.npm;
    console.log(`✓ view.tsx compiles${r.npm.length ? ` (from npm: ${r.npm.join(', ')})` : ''}`);
  } else for (const e of r.errors) fail(`view.tsx${e.line ? `:${e.line}` : ''}: ${e.message}`);
  const tsc = spawnSync('node_modules/.bin/tsc', ['-p', '.'], { encoding: 'utf8' });
  // npm packages arrive at run time: their types can't be here
  const lines = (tsc.stdout + tsc.stderr).trim().split('\n').filter((l) => l && !npm.some((n) => l.includes(`'${n}'`) && /TS2307|TS7016/.test(l)));
  if (lines.length === 0) console.log('✓ types check');
  else fail(`types:\n${lines.join('\n')}`);
}

try {
  const m = JSON.parse(readFileSync('view.json', 'utf8')) as { title?: unknown; reads?: unknown; writes?: unknown; npm?: unknown };
  if (typeof m.title !== 'string' || !m.title.trim()) fail('view.json: needs a `title`');
  const list = (v: unknown) => (Array.isArray(v) && v.every((g) => typeof g === 'string') ? (v as string[]) : null);
  const [reads, writes] = [list(m.reads), list(m.writes)];
  if (!reads || !writes) fail('view.json: `reads` and `writes` must be lists of gestalts, like "note@1"');
  else {
    for (const g of [...reads, ...writes]) if (!CORE.includes(g)) fail(`view.json: no gestalt ${g} here; there are ${CORE.join(', ')}`);
    if (!isMap(m.npm ?? {}) || !Object.values(m.npm ?? {}).every((v) => typeof v === 'string')) fail('view.json: `npm` maps package names to versions, like {"three": "0.170.0"}');
    for (const g of writes) if (!reads.includes(g)) fail(`view.json: it writes ${g}, so it must read it too`);
    console.log('✓ view.json is fine');
  }
} catch (e) {
  fail(`view.json: ${(e as Error).message}`);
}

if (!failed) console.log('✓ all good');
process.exit(failed ? 1 : 0);

/**
 * A draft view: what the workshop checks before it shows view.tsx (the same compile), plus its types, view.json, npm
 * imports pinned in it, and the draft's own gestalts (`gestalts/`) and data (`data/`). The app checks the ymls again
 * when it saves them and refuses what isn't valid.
 */
import { compile } from '@gestalts/view/compile';
import { parse } from 'yaml';
import { packageName, result, type CheckItem, type CheckResult, type Files, type Platform } from './index.ts';

export type ViewContext = {
  /** the gestalts the app has (`name@N`), which the view may read and write besides its own */
  gestalts: string[];
};

const TYPES = ['any', 'string', 'text', 'number', 'integer', 'bool', 'date', 'partial_date', 'datetime', 'url', 'string_list', 'list', 'map', 'blob', 'ref', 'ref_list', 'ref_map', 'relationships', 'blobs'];
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function checkView(files: Files, ctx: ViewContext, platform: Platform): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const problems: string[] = [];
  const fail = (m: string) => problems.push(m);
  const text = (p: string) => (typeof files[p] === 'string' ? (files[p] as string) : undefined);
  const ymls = (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.yml')).sort();

  let manifest: Record<string, unknown> | undefined;
  try {
    const m = JSON.parse(text('view.json') ?? '') as unknown;
    if (isMap(m)) manifest = m;
  } catch { /* reported below */ }
  const pkg = String(manifest?.package ?? '');

  /** A field rule's mistakes, as the core would find them (its type, and keys only some types take). */
  const checkRule = (path: string, r: unknown): void => {
    if (!isMap(r)) return void fail(`${path}: a rule is a map, like { type: string, required: true }`);
    const type = r.type ?? 'any';
    if (typeof type !== 'string' || !TYPES.includes(type)) return void fail(`${path}: type must be one of ${TYPES.join(', ')}`);
    if (r.fields !== undefined && type !== 'map') fail(`${path}: \`fields\` needs type: map`);
    if (r.items !== undefined && type !== 'list') fail(`${path}: \`items\` needs type: list`);
    if (isMap(r.fields)) for (const [k, sub] of Object.entries(r.fields)) checkRule(`${path}.${k}`, sub);
    if (r.items !== undefined) checkRule(`${path}[]`, r.items);
    if (r.values !== undefined) checkRule(`${path}{}`, r.values);
  };

  const own: string[] = [];
  for (const path of ymls('gestalts')) {
    const f = path.slice('gestalts/'.length);
    const m = /^([a-z0-9-]+)@([1-9][0-9]*)\.yml$/.exec(f);
    if (!m) { fail(`${path}: name it <name>@<version>.yml, the name in lowercase letters, digits and -`); continue; }
    own.push(`${pkg}/${m[1]}@${m[2]}`);
    try {
      const d = parse(text(path) ?? '') as unknown;
      if (!isMap(d)) { fail(`${path}: must be a map with \`fields\``); continue; }
      for (const k of Object.keys(d)) if (!['description', 'fields', 'merge'].includes(k)) fail(`${path}: \`${k}\` isn't part of a definition (description, fields, merge)`);
      if (!isMap(d.fields)) fail(`${path}: \`fields\` must be a map of field rules`);
      else for (const [k, r] of Object.entries(d.fields)) {
        if (k === 'id' || k === 'gestalt') fail(`${path}: \`${k}\` belongs to every yml and can't be declared`);
        checkRule(`${path}: ${k}`, r);
      }
    } catch (e) { fail(`${path}: ${(e as Error).message}`); }
  }
  const known = [...ctx.gestalts, ...own];
  items.push({ ok: problems.length === 0, name: own.length ? `its own gestalts: ${own.join(', ')}` : 'its own gestalts (none)', message: problems.splice(0).join('\n') });

  let data = 0;
  for (const path of ymls('data')) {
    try {
      const d = parse(text(path) ?? '') as unknown;
      const g = isMap(d) ? d.gestalt : undefined;
      if (typeof g !== 'string') fail(`${path}: needs \`gestalt: name@N\``);
      else if (!known.includes(g)) fail(`${path}: no gestalt ${g} here`);
      else data++;
    } catch (e) { fail(`${path}: ${(e as Error).message}`); }
  }
  items.push({ ok: problems.length === 0, name: `${data} yml(s) in data/ name a gestalt here`, message: problems.splice(0).join('\n') });

  const npmPinned = isMap(manifest?.npm) ? (manifest.npm as Record<string, unknown>) : {};
  if (!manifest) fail('view.json: missing, or not a JSON object');
  else {
    const list = (v: unknown) => (Array.isArray(v) && v.every((g) => typeof g === 'string') ? (v as string[]) : null);
    const [reads, writes] = [list(manifest.reads), list(manifest.writes)];
    if (typeof manifest.title !== 'string' || !manifest.title.trim()) fail('view.json: needs a `title`');
    if (!reads || !writes) fail('view.json: `reads` and `writes` must be lists of gestalts, like "note@1"');
    else {
      for (const g of [...reads, ...writes]) if (!known.includes(g)) fail(`view.json: no gestalt ${g} here; there are ${known.join(', ')}`);
      for (const g of writes) if (!reads.includes(g)) fail(`view.json: it writes ${g}, so it must read it too`);
    }
    if (!isMap(manifest.npm ?? {}) || !Object.values(npmPinned).every((v) => typeof v === 'string')) fail('view.json: `npm` maps package names to versions, like {"three": "0.170.0"}');
  }
  items.push({ ok: problems.length === 0, name: 'view.json', message: problems.splice(0).join('\n') });

  const source = text('view.tsx');
  if (source === undefined) {
    items.push({ ok: false, name: 'view.tsx', message: 'view.tsx is missing' });
    return result(items);
  }
  const compiled = compile(source);
  if (!compiled.ok) {
    items.push({ ok: false, name: 'view.tsx compiles', message: compiled.errors.map((e) => `view.tsx${e.line ? `:${e.line}` : ''}: ${e.message}`).join('\n') });
    return result(items);
  }
  items.push({ ok: true, name: `view.tsx compiles${compiled.npm.length ? ` (from npm: ${compiled.npm.join(', ')})` : ''}` });
  const unpinned = [...new Set(compiled.npm.map(packageName))].filter((n) => typeof npmPinned[n] !== 'string');
  if (unpinned.length) items.push({ ok: false, name: 'npm imports are pinned', message: unpinned.map((n) => `view.json: add "${n}" to \`npm\` with an exact version, like {"${n}": "1.2.3"}`).join('\n') });

  // npm packages arrive at run time: their types can't be here
  const npm = compiled.npm;
  const errors = await platform.typecheck('view', { 'view.tsx': source }, (m) => npm.some((n) => m.includes(`'${n}'`) && /TS2307|TS7016/.test(m)));
  items.push({ ok: errors.length === 0, name: 'types check', message: errors.join('\n') });
  return result(items);
}

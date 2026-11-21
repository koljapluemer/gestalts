// The teacher server's helper for what only Node does well: compiling and typechecking a draft's view the way the
// workshop does, and bundling npm packages. `gestalts-teacher` runs it as a child and speaks JSON lines with it on
// stdin/stdout: `{id, op, ...}` in, `{id, ok: true, result}` or `{id, ok: false, error}` out, in any order.
//
// - `check {files, gestalts}`: the agent template's `node check.ts` in a scratch workspace laid out as a local agent's,
//   plus npm: each package view.tsx imports must be in view.json's `npm`, at a version that bundles
// - `compile {source}`: the view as the frame loads it
// - `npm {specifier, version}`: one bundle, from the cache when it was made before
//
// Env: TEACHER_TEMPLATE (the agent template, with its node_modules), TEACHER_NPM_CACHE.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { compile } from '@gestalts/view/compile';
import { bundle, isVersion, packageName, resolveVersion } from '@gestalts/npm-bundle';

const here = dirname(new URL(import.meta.url).pathname);
const TEMPLATE = resolve(process.env.TEACHER_TEMPLATE ?? join(here, '../../../packages/workshop/agent-template'));
const CACHE = resolve(process.env.TEACHER_NPM_CACHE ?? join(tmpdir(), 'gestalts-npm-cache'));
const run = promisify(execFile);
const FILE = /^(view\.tsx|view\.json|gestalts\/[a-z0-9-]+@[1-9][0-9]*\.yml|data\/[^/\\.][^/\\]{0,199}\.yml)$/;

type Request = { id: number; op: string; [k: string]: unknown };

async function check(files: Record<string, string>, gestalts: string[]): Promise<{ ok: boolean; output: string }> {
  const ws = await mkdtemp(join(tmpdir(), 'teacher-check-'));
  try {
    for (const f of ['tsconfig.json', 'check.ts']) await copyFile(join(TEMPLATE, f), join(ws, f));
    await symlink(join(TEMPLATE, 'node_modules'), join(ws, 'node_modules'), 'dir');
    await mkdir(join(ws, '.workshop'));
    await writeFile(join(ws, '.workshop', 'gestalts.json'), JSON.stringify(gestalts));
    for (const [path, text] of Object.entries(files)) {
      if (!FILE.test(path)) continue;
      await mkdir(dirname(join(ws, path)), { recursive: true });
      await writeFile(join(ws, path), text);
    }
    let output = '';
    let ok = true;
    try {
      const r = await run(process.execPath, ['check.ts'], { cwd: ws, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      output = r.stdout + r.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      output = (err.stdout ?? '') + (err.stderr ?? '') || err.message;
      ok = false;
    }
    const npm = await checkNpm(files);
    const lines = [...output.replace(/✓ all good\n?/, '').trimEnd().split('\n'), ...npm.lines];
    if (ok && npm.ok) lines.push('✓ all good');
    return { ok: ok && npm.ok, output: `${lines.join('\n')}\n` };
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

/** Every npm import listed in view.json at an exact version, and bundling: or what to put there. */
async function checkNpm(files: Record<string, string>): Promise<{ ok: boolean; lines: string[] }> {
  const compiled = compile(files['view.tsx'] ?? '');
  if (!compiled.ok || compiled.npm.length === 0) return { ok: true, lines: [] };
  let declared: Record<string, string> = {};
  try { declared = (JSON.parse(files['view.json'] ?? '{}') as { npm?: Record<string, string> }).npm ?? {}; } catch { /* check.ts says so */ }
  const lines: string[] = [];
  let ok = true;
  for (const spec of compiled.npm) {
    const name = packageName(spec);
    if (!name) { ok = false; lines.push(`✗ ${spec}: not an npm import`); continue; }
    const version = declared[name];
    if (!version || !isVersion(version)) {
      ok = false;
      const latest = await resolveVersion(name, version ?? 'latest').catch((e: Error) => e.message);
      lines.push(isVersion(latest) ? `✗ view.json: npm: add "${name}": "${latest}" (the latest), or the exact version you want` : `✗ ${name}: ${latest}`);
      continue;
    }
    try {
      const b = await bundle(spec, version, { cacheDir: CACHE });
      lines.push(`✓ ${spec}@${version} bundles (${Math.round(b.bytes / 1024)} KB)`);
    } catch (e) {
      ok = false;
      lines.push(`✗ ${spec}@${version} doesn't bundle: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return { ok, lines };
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'check': return check(req.files as Record<string, string>, (req.gestalts as string[]) ?? []);
    case 'compile': return compile(String(req.source ?? ''));
    case 'npm': return bundle(String(req.specifier), String(req.version), { cacheDir: CACHE });
    default: throw new Error(`no op ${req.op}`);
  }
}

const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let req: Request;
  try { req = JSON.parse(line) as Request; } catch { return; }
  handle(req).then((result) => out({ id: req.id, ok: true, result }), (e: unknown) => out({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }));
});

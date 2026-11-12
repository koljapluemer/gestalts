// `node check.ts`: what the workshop checks before it shows view.tsx (the same compile), plus its types and view.json.
// Exit code 0 when all is well.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { compile } from '@gestalts/view/compile';

let failed = false;
const fail = (msg: string) => { failed = true; console.log(`✗ ${msg}`); };

/** What this view may touch, in the workshop's data; anything a plugin defines isn't there. */
const CORE = ['note@1', 'source@1', 'concept@2', 'concept-link@1', 'practice-event@1', 'flashcard@1', 'deck@1', 'fsrs-data@1', 'practice-session@1'];

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
  const m = JSON.parse(readFileSync('view.json', 'utf8')) as { title?: unknown; reads?: unknown; writes?: unknown };
  if (typeof m.title !== 'string' || !m.title.trim()) fail('view.json: needs a `title`');
  const list = (v: unknown) => (Array.isArray(v) && v.every((g) => typeof g === 'string') ? (v as string[]) : null);
  const [reads, writes] = [list(m.reads), list(m.writes)];
  if (!reads || !writes) fail('view.json: `reads` and `writes` must be lists of gestalts, like "note@1"');
  else {
    for (const g of [...reads, ...writes]) if (!CORE.includes(g)) fail(`view.json: no gestalt ${g} here; there are ${CORE.join(', ')}`);
    for (const g of writes) if (!reads.includes(g)) fail(`view.json: it writes ${g}, so it must read it too`);
    console.log('✓ view.json is fine');
  }
} catch (e) {
  fail(`view.json: ${(e as Error).message}`);
}

if (!failed) console.log('✓ all good');
process.exit(failed ? 1 : 0);

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkView, checkViz, type Files } from './index.ts';
import { nodePlatform } from './node.ts';

const root = join(import.meta.dirname, '../../..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === 'dist' ? [] : walk(p)) : [p];
});
const filesOf = (dir: string, binary = /\.(png|jpe?g)$/): Files =>
  Object.fromEntries(walk(dir).map((p) => [relative(dir, p), binary.test(p) ? new Uint8Array(readFileSync(p)) : readFileSync(p, 'utf8')]));
/** what the workshop sends as the app's gestalts */
const GESTALTS = ['note@1', 'source@1', 'concept@2', 'concept@3', 'concept-link@1', 'practice-event@1', 'practice-event@2', 'flashcard@1', 'multiple-choice@1', 'item-model@1', 'deck@2', 'fsrs-data@1', 'practice-session@1'];

describe('a view', () => {
  const examples = join(root, 'packages/workshop/agent-template/examples');
  for (const name of readdirSync(examples)) {
    it(`example ${name} passes`, async () => {
      const r = await checkView(filesOf(join(examples, name)), { gestalts: GESTALTS }, nodePlatform);
      expect(r.report).toContain('all good');
    }, 60_000);
  }
  const good = filesOf(join(examples, 'note-count'));
  it('reports a type error with its line', async () => {
    const r = await checkView({ ...good, 'view.tsx': `${good['view.tsx'] as string}\nconst n: number = 'x';\n` }, { gestalts: GESTALTS }, nodePlatform);
    expect(r.ok).toBe(false);
    expect(r.report).toMatch(/view\.tsx:\d+:\d+ - error TS2322/);
  }, 60_000);
  it('wants npm imports pinned, without their types', async () => {
    const source = `import confetti from 'canvas-confetti';\n${good['view.tsx'] as string}\nvoid confetti;\n`;
    const r = await checkView({ ...good, 'view.tsx': source }, { gestalts: GESTALTS }, nodePlatform);
    expect(r.report).toContain('add "canvas-confetti" to `npm`');
    expect(r.report).toContain('✓ types check');
  }, 60_000);
  it('knows only the gestalts here', async () => {
    const json = JSON.parse(good['view.json'] as string) as { reads: string[] };
    const r = await checkView({ ...good, 'view.json': JSON.stringify({ ...json, reads: [...json.reads, 'nope@1'] }) }, { gestalts: GESTALTS }, nodePlatform);
    expect(r.report).toContain('no gestalt nope@1 here');
  }, 60_000);
});

describe('a viz', () => {
  const examples = join(root, 'packages/viz/examples');
  for (const name of readdirSync(examples)) {
    it(`example ${name} passes and builds`, async () => {
      const r = await checkViz(filesOf(join(examples, name)), nodePlatform);
      expect(r.report).toContain('all good');
      expect(r.built).toContain('data-gestalts-viz');
    }, 60_000);
  }
  it('reports a failing check', async () => {
    const files = filesOf(join(examples, 'bezier'));
    const source = (files['viz.ts'] as string).replace(/checks:\s*\[/, "checks: [{ name: 'never', expect: () => false },");
    const r = await checkViz({ ...files, 'viz.ts': source }, nodePlatform);
    expect(r.ok).toBe(false);
    expect(r.report).toContain('✗ check: never');
    expect(r.built).toBeUndefined();
  }, 60_000);
  it('wants packages at exact versions', async () => {
    const r = await checkViz({ 'viz.ts': "import * as d3 from 'd3';\nexport default d3;\n", 'package.json': '{"dependencies":{"d3":"^7"}}' }, nodePlatform);
    expect(r.report).toContain("isn't a package at an exact version");
  }, 60_000);
});

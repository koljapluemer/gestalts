import { describe, expect, it } from 'vitest';
import { parseManifest } from './lesson';

const ok = { format: 'lesson@1', title: 'der, die, das', runtime: 'abc', reads: ['d-x/noun@1', 'practice-event@1'], writes: ['practice-event@1'], view: 'view.js', npm: { three: '/npm/three@0.170.0-1a2b.js' }, published: '2026-11-20T10:00:00Z' };

describe('a lesson manifest', () => {
  it('is taken as it is', () => {
    expect(parseManifest(ok)).toEqual(ok);
  });

  it('is refused when it asks for more than a lesson gets, or points elsewhere', () => {
    for (const [why, bad] of [
      ['the network', { ...ok, network: ['example.org'] }],
      ['a model', { ...ok, llm: true }],
      ['another sandbox', { ...ok, permissions: ['same-origin'] }],
      ['npm from a CDN', { ...ok, npm: { three: 'https://esm.sh/three' } }],
      ['a view elsewhere', { ...ok, view: '../other/view.js' }],
      ['writing what it does not read', { ...ok, writes: ['note@1'] }],
      ['another format', { ...ok, format: 'lesson@2' }],
    ] as const) expect(() => parseManifest(bad), why).toThrow();
  });
});

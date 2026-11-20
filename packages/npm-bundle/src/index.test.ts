import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bundle, parseSpecifier, resolveVersion } from './index';

/** Installs a made-up package instead of asking npm. */
function fake(files: Record<string, string>) {
  return vi.fn(async (dir: string, name: string) => {
    for (const [path, text] of Object.entries(files)) {
      const file = join(dir, 'node_modules', name, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
  });
}

const pkg = { 'package.json': JSON.stringify({ name: 'tiny', version: '1.2.3', type: 'module', exports: { '.': './index.js', './addons/*': './addons/*' } }) };

describe('specifiers', () => {
  it('splits a package from the path inside it', () => {
    expect(parseSpecifier('three')).toEqual({ name: 'three', subpath: '' });
    expect(parseSpecifier('three/addons/controls/OrbitControls.js')).toEqual({ name: 'three', subpath: 'addons/controls/OrbitControls.js' });
    expect(parseSpecifier('@scope/pkg/x')).toEqual({ name: '@scope/pkg', subpath: 'x' });
  });

  it('refuses what could leave the package or isn’t a name', () => {
    for (const bad of ['three/../../etc', 'Three', '../x', 'a//b', '@scope', 'a b', 'three/./x']) expect(parseSpecifier(bad), bad).toBeNull();
  });
});

describe('versions', () => {
  const registry = vi.fn(async () => new Response(JSON.stringify({ 'dist-tags': { latest: '0.171.0' }, versions: { '0.170.0': {}, '0.170.1': {}, '0.171.0': {}, '0.172.0-beta.1': {} } })));
  it('keeps an exact one, and resolves a tag or a prefix to the newest release', async () => {
    expect(await resolveVersion('three', '0.170.0', { fetch: registry })).toBe('0.170.0');
    expect(await resolveVersion('three', 'latest', { fetch: registry })).toBe('0.171.0');
    expect(await resolveVersion('three', '0.170', { fetch: registry })).toBe('0.170.1');
    await expect(resolveVersion('three', '9', { fetch: registry })).rejects.toThrow('no version');
  });
});

describe('bundling', () => {
  it('makes one module, leaves the runtime external, and caches it', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'npm-bundle-'));
    const install = fake({ ...pkg, 'index.js': "import { useState } from 'react';\nimport { helper } from './helper.js';\nexport const answer = helper(41);\nexport default useState;\n", 'helper.js': 'export const helper = (n) => n + 1;\n' });
    const b = await bundle('tiny', '1.2.3', { cacheDir, install });
    const code = await readFile(b.file, 'utf8');
    expect(code).toMatch(/from\s*"react"/);
    expect(code).not.toContain('./helper.js');
    expect(b).toMatchObject({ specifier: 'tiny', version: '1.2.3', needs: [] });
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await bundle('tiny', '1.2.3', { cacheDir, install })).toEqual(b);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('bundles a subpath against its package root, which it needs in the import map', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'npm-bundle-'));
    const install = fake({ ...pkg, 'index.js': 'export const core = 1;\n', 'addons/orbit.js': "import { core } from 'tiny';\nexport const orbit = core + 1;\n" });
    const b = await bundle('tiny/addons/orbit.js', '1.2.3', { cacheDir, install });
    expect(b.needs).toEqual(['tiny']);
    expect(await readFile(b.file, 'utf8')).toMatch(/from\s*"tiny"/);
  });

  it('refuses a range: what is bundled is pinned', () => {
    expect(() => bundle('tiny', '^1.2.0', { cacheDir: '/nowhere' })).toThrow('exact version');
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distributionFiles, loadApp } from './index';

const VIEW = 'export default function View() { return null; }\n';

/** A folder with `files` (path → text) in it. */
function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gestalts-vite-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const plugin = (id: string) => ({ [`plugins/${id}/plugin.yml`]: `id: ${id}\ntitle: ${id}\nversion: 1.0.0\n`, [`plugins/${id}/view.tsx`]: VIEW });

describe('distributions', () => {
  it('reads one distribution.yml as the unnamed one', () => {
    const root = folder({ ...plugin('a'), 'app/distribution.yml': 'id: app\nplugins: [../plugins/a]\n' });
    expect([...distributionFiles(join(root, 'app')).keys()]).toEqual(['']);
    expect(loadApp(join(root, 'app')).get('')?.plugins.map((p) => p.id)).toEqual(['a']);
  });

  it('reads distributions/<name>.yml, with paths from each file, and may share a plugin', () => {
    const root = folder({
      ...plugin('a'), ...plugin('b'),
      'app/distributions/home.yml': 'id: home\nplugins: [../../plugins/a, ../../plugins/b]\n',
      'app/distributions/make.yml': 'id: make\nplugins: [../../plugins/b]\n',
    });
    const app = loadApp(join(root, 'app'));
    expect([...app.keys()]).toEqual(['home', 'make']);
    expect(app.get('home')?.plugins.map((p) => p.id)).toEqual(['a', 'b']);
    expect(app.get('make')?.distribution.id).toBe('make');
  });

  it('refuses two plugins with one id, and one id for two distributions', () => {
    const twoA = folder({
      ...plugin('a'), 'other/a/plugin.yml': 'id: a\ntitle: a\nversion: 1.0.0\n', 'other/a/view.tsx': VIEW,
      'app/distributions/x.yml': 'id: x\nplugins: [../../plugins/a]\n',
      'app/distributions/y.yml': 'id: y\nplugins: [../../other/a]\n',
    });
    expect(() => loadApp(join(twoA, 'app'))).toThrow(/two plugins/);
    const sameId = folder({ 'app/distributions/x.yml': 'id: x\n', 'app/distributions/y.yml': 'id: x\n' });
    expect(() => loadApp(join(sameId, 'app'))).toThrow(/another distribution's/);
  });

  it('refuses both forms at once', () => {
    const root = folder({ 'app/distribution.yml': 'id: x\n', 'app/distributions/y.yml': 'id: y\n' });
    expect(() => distributionFiles(join(root, 'app'))).toThrow(/one or the other/);
  });
});

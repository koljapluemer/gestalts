// Every app's distribution.yml names plugins from the repo's plugins/ (or the app's own plugins/), never another
// app's files: the contract no import checker sees. Exits non-zero, listing what's wrong.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const plugins = join(root, 'plugins');

function distributions(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'gen') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...distributions(p));
    else if (e.name === 'distribution.yml') out.push(p);
  }
  return out;
}

const inside = (dir: string, path: string) => path.startsWith(dir + sep);
const problems: string[] = [];
for (const file of distributions(join(root, 'apps'))) {
  const app = dirname(file);
  const own = join(root, 'apps', relative(join(root, 'apps'), app).split(sep)[0], 'plugins');
  const d = (parse(readFileSync(file, 'utf8')) ?? {}) as { core?: string[]; plugins?: string[] };
  for (const entry of [...(d.core ?? []), ...(d.plugins ?? [])]) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (!inside(plugins, path) && !inside(own, path)) problems.push(`${where}: ${entry} is outside plugins/ and the app's own plugins/`);
    else if (!existsSync(join(path, 'plugin.yml'))) problems.push(`${where}: ${entry} has no plugin.yml`);
  }
}
for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log('distribution.yml files: every plugin in plugins/');

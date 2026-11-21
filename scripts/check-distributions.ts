// Every app's distribution.yml (or distributions/<name>.yml) names plugins from the repo's plugins/ (or the app's own
// plugins/) and model packages from the repo's gestalts/, never another app's files: the contract no import checker
// sees. Exits non-zero, listing what's wrong.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const plugins = join(root, 'plugins');
const gestalts = join(root, 'gestalts');
const definitions = (dir: string) => readdirSync(dir).filter((f) => /^v\d+\.yml$/.test(f));
// a folder of gestalt folders; one of the core's holds v<N>.yml itself
const isPackage = (dir: string) => existsSync(dir) && definitions(dir).length === 0
  && readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && definitions(join(dir, e.name)).length > 0);

function distributions(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'gen') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...distributions(p));
    else if (e.name === 'distribution.yml' || (e.name.endsWith('.yml') && dirname(p).endsWith(`${sep}distributions`))) out.push(p);
  }
  return out;
}

const inside = (dir: string, path: string) => path.startsWith(dir + sep);
const problems: string[] = [];
for (const file of distributions(join(root, 'apps'))) {
  // paths are from the file
  const app = dirname(file);
  const own = join(root, 'apps', relative(join(root, 'apps'), app).split(sep)[0], 'plugins');
  const d = (parse(readFileSync(file, 'utf8')) ?? {}) as { core?: string[]; plugins?: string[]; models?: string[] };
  for (const entry of [...(d.core ?? []), ...(d.plugins ?? [])]) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (!inside(plugins, path) && !inside(own, path)) problems.push(`${where}: ${entry} is outside plugins/ and the app's own plugins/`);
    else if (!existsSync(join(path, 'plugin.yml'))) problems.push(`${where}: ${entry} has no plugin.yml`);
  }
  for (const entry of d.models ?? []) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (dirname(path) !== gestalts) problems.push(`${where}: model ${entry} is not a package in gestalts/`);
    else if (!isPackage(path)) problems.push(`${where}: model ${entry} is not a package (gestalts/<package>/<name>/v<N>.yml)`);
  }
}
// a lesson made in the teacher app runs in the player and is checked by the server: all three know the same models
const models = (file: string) => (((parse(readFileSync(join(root, 'apps', file), 'utf8')) ?? {}) as { models?: string[] }).models ?? []).map((m) => m.split('/').pop()).sort().join(', ');
const server = /pub const MODELS: &\[&str\] = &\[([^\]]*)\]/.exec(readFileSync(join(root, 'crates/teacher/src/lib.rs'), 'utf8'))?.[1].split(',').map((m) => m.trim().replaceAll('"', '')).filter(Boolean).sort().join(', ');
const teacher = models('web/distributions/teacher.yml');
const player = models('player/distribution.yml');
if (teacher !== player || teacher !== server) problems.push(`the web app's teacher area (${teacher}), the player (${player}) and crates/teacher's MODELS (${server}) must name the same models`);
for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log('distributions: every plugin in plugins/, every model in gestalts/');

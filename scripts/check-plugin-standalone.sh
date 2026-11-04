#!/usr/bin/env bash
# Builds plugins/<id> outside the workspace, against packed @gestalts/sdk, kit and learning only, the way it would
# build in a repo of its own. Fails on anything that reaches back into the monorepo.
set -euo pipefail
id="${1:?usage: check-plugin-standalone.sh <plugin id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$root/plugins/$id"
[ -f "$plugin/plugin.yml" ] || { echo "no plugin $id" >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/gestalts-standalone-$id-XXXX")"
trap 'rm -rf "$work"' EXIT

if grep -rnE "from '(\.\./){3,}|from '@gestalts/(client|ui)'" "$plugin/ui/src"; then
  echo "$id imports from outside the public packages" >&2; exit 1
fi

mkdir -p "$work/packs"
for pkg in sdk kit learning; do (cd "$root/packages/$pkg" && pnpm pack --pack-destination "$work/packs" >/dev/null); done
pack() { ls "$work/packs"/gestalts-"$1"-*.tgz; }

cp -r "$plugin" "$work/$id"
rm -rf "$work/$id/node_modules" "$work/$id/dist"
cd "$work/$id"
node - "$(pack sdk)" "$(pack kit)" "$(pack learning)" "$root/package.json" <<'JS'
const fs = require('fs');
const [sdk, kit, learning, rootPkg] = process.argv.slice(2);
const files = { '@gestalts/sdk': `file:${sdk}`, '@gestalts/kit': `file:${kit}`, '@gestalts/learning': `file:${learning}` };
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dev = JSON.parse(fs.readFileSync(rootPkg, 'utf8')).devDependencies;
for (const [k, v] of Object.entries(pkg.dependencies)) {
  if (String(v).startsWith('workspace:')) {
    if (!files[k]) throw new Error(`${k} is not a public package`);
    pkg.dependencies[k] = files[k];
  }
}
pkg.devDependencies = { ...pkg.devDependencies, typescript: dev.typescript, vite: dev.vite, '@vitejs/plugin-react': dev['@vitejs/plugin-react'], '@types/react': dev['@types/react'], 'react-dom': pkg.peerDependencies.react };
pkg.pnpm = { overrides: files };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
JS
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2024", "DOM", "DOM.Iterable"], "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "verbatimModuleSyntax": true, "skipLibCheck": true, "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["ui/src"],
  "exclude": ["ui/src/**/*.test.ts"]
}
JSON
cat > vite.config.ts <<'JS'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// the host provides React and the public packages; the bundle is the plugin alone
export default defineConfig({
  plugins: [react()],
  build: { lib: { entry: 'ui/src/index.ts', formats: ['es'], fileName: 'index' }, rollupOptions: { external: (id) => /^(react|react-dom|@gestalts\/)/.test(id) } },
});
JS
pnpm install --silent --prefer-offline --ignore-workspace
pnpm exec tsc -p .
pnpm exec vite build --logLevel warn
ls dist/index.js >/dev/null
echo "$id builds on its own against @gestalts/sdk, kit and learning"

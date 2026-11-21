import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const webApps = [
  'apps/web',
  'apps/gestalter/distribution-android',
  'apps/node/settings',
];

const sourceFor = (app: string) => {
  try {
    readFileSync(`${app}/icon.svg`);
    return `${app}/icon.svg`;
  } catch {
    return 'assets/icon.svg';
  }
};
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = (message: string): never => {
  throw new Error(`${message}\nRun \`mise run icons\` and commit the generated files.`);
};

for (const app of webApps) {
  const html = readFileSync(`${app}/index.html`, 'utf8');
  if (!html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')) {
    fail(`${app}/index.html does not reference its favicon`);
  }
  if (hash(`${app}/public/favicon.svg`) !== hash(sourceFor(app))) fail(`${app}/public/favicon.svg is stale`);
}

const pngSize = (path: string) => {
  const png = readFileSync(path);
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail(`${path} is not a PNG`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};
const nativeTargets = [
  ['apps/node/desktop', 'apps/node/desktop/assets/icon.source.sha256'],
  ['apps/node/android', 'apps/node/android/icons/icon.source.sha256'],
];
for (const [app, stamp] of nativeTargets) {
  if (readFileSync(stamp, 'utf8').trim() !== hash(sourceFor(app))) fail(`${app}'s generated icons are stale`);
}

const pngs = new Map([
  ['apps/node/desktop/assets/icon.png', 256],
  ['apps/node/android/icons/32x32.png', 32],
  ['apps/node/android/icons/128x128.png', 128],
  ['apps/node/android/icons/128x128@2x.png', 256],
  ['apps/node/android/icons/icon.png', 512],
]);
for (const [path, expected] of pngs) {
  const [width, height] = pngSize(path);
  if (width !== expected || height !== expected) fail(`${path} is ${width}x${height}, expected ${expected}x${expected}`);
}

const desktopConfig = readFileSync('apps/node/desktop/Cargo.toml', 'utf8');
if (!desktopConfig.includes('icons = ["assets/icon.png"]')) fail('the desktop packager does not reference its icon');
if (!desktopConfig.includes('dest = "/usr/share/icons/hicolor/256x256/apps/gestalts-node.png"')) fail('the RPM does not install its icon');
const androidConfig = readFileSync('apps/node/android/tauri.conf.json', 'utf8');
for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png']) {
  if (!androidConfig.includes(`icons/${name}`)) fail(`the Android bundle does not reference ${name}`);
}

console.log('Web, desktop and Android icons are present and wired into their builds.');

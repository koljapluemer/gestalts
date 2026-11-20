/**
 * A published lesson: data, not a build. Each version is a folder of static files, immutable once written:
 *
 * ```
 * lessons/<lesson>/<version>/manifest.json   this
 *                            view.js         the compiled view
 *                            index.json      the ymls it ships with, as a published deck: {ymls, blobs}
 *                            ymls.json       [{id, text}], its definitions among them
 *                            blobs/<name>
 * npm/<package>@<version>-<hash>.js           npm bundles, shared by every lesson
 * runtime/<runtime>/                          the player for one frame runtime
 * ```
 *
 * `/l/<lesson>` is the link; `/l/<lesson>/current` answers `{manifest}`, the path of its current version's manifest,
 * which is the one thing that changes (a new version, or 410 once unpublished).
 */
export const LESSON = 'lesson@1';

export type LessonManifest = {
  format: typeof LESSON;
  title: string;
  /** the frame runtime it was compiled against (`FrameRuntime.version`): the player that runs it */
  runtime: string;
  reads: string[];
  writes: string[];
  /** the compiled view, relative to the manifest */
  view: string;
  /** each npm import, by specifier, to the absolute path of its bundle on the lesson domain */
  npm: Record<string, string>;
  /** when this version was published, ISO */
  published: string;
};

/** A lesson's id in its link: 128 random bits, base64url. */
export const LESSON_ID = /^[A-Za-z0-9_-]{22}$/;

const KEYS = ['format', 'title', 'runtime', 'reads', 'writes', 'view', 'npm', 'published'];
const NPM_PATH = /^\/npm\/[A-Za-z0-9._@+-]+\.js$/;

/**
 * A manifest as the player trusts it, or why not. Anything it doesn't know is refused rather than ignored: a manifest
 * asking for the network, a model, a backend or another sandbox isn't a lesson this player runs.
 */
export function parseManifest(v: unknown): LessonManifest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('a manifest is a map');
  const m = v as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !KEYS.includes(k));
  if (extra.length) throw new Error(`a lesson can't have ${extra.join(', ')}`);
  if (m.format !== LESSON) throw new Error(`not a ${LESSON}`);
  const text = (k: string) => { if (typeof m[k] !== 'string' || !(m[k] as string)) throw new Error(`${k} is missing`); return m[k] as string; };
  const list = (k: string) => { if (!Array.isArray(m[k]) || !(m[k] as unknown[]).every((x) => typeof x === 'string')) throw new Error(`${k} must be a list of gestalts`); return m[k] as string[]; };
  const view = text('view');
  if (!/^[A-Za-z0-9._-]+\.js$/.test(view)) throw new Error('view must be a file next to the manifest');
  const npm = m.npm;
  if (typeof npm !== 'object' || npm === null || Array.isArray(npm)) throw new Error('npm must be a map');
  for (const [spec, path] of Object.entries(npm)) if (typeof path !== 'string' || !NPM_PATH.test(path)) throw new Error(`npm: ${spec} must be loaded from /npm/`);
  const writes = list('writes');
  const reads = list('reads');
  for (const g of writes) if (!reads.includes(g)) throw new Error(`it writes ${g} without reading it`);
  return { format: LESSON, title: text('title'), runtime: text('runtime'), reads, writes, view, npm: npm as Record<string, string>, published: text('published') };
}

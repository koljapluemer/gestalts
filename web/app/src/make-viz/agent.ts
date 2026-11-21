import { bridgeAvailable, pairBridge, runOnBridge, vizCheckTool } from '@gestalts/workshop';
import { AGENT_NODE } from '../nodes';
import { vizTemplate } from './template';
import { fromBase64, toBase64 } from './viz';

export type BuildRequest = {
  viz: string; title: string; spec: string; source?: string; packages: string[];
  /** by label, as base64 */
  files: Record<string, string>;
};

export type BuildEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'error'; message: string }
  /** the end of a build: what it made; `built` and `still` (base64) only when the check passed */
  | { type: 'result'; ok: boolean; check: string; generator: string; source: string | null; packages: string[]; built?: string; still?: string }
  | { type: 'done' };

/** Who built it, kept on the viz. */
const GENERATOR = 'claude-bridge-1';
const SYSTEM = 'You build one visualization in this directory. CLAUDE.md here is the contract: read it first. Only viz.ts and package.json are kept; run the check tool before you finish.';
/** what a build makes: everything else in its workspace is the template's or the spec's */
const KEEP = String.raw`viz\.ts|package\.json`;

export const available = () => bridgeAvailable(AGENT_NODE);
export const connect = () => pairBridge(AGENT_NODE);

const packagesJson = (packages: string[]) => `${JSON.stringify({
  private: true, type: 'module', dependencies: Object.fromEntries(packages.map((p) => [p.slice(0, p.lastIndexOf('@')), p.slice(p.lastIndexOf('@') + 1)])),
}, null, 2)}\n`;

/**
 * One build by Claude Code on this computer, through the Claude bridge: it writes viz.ts from the spec, checking it
 * with the page's check as it goes. Then the page checks what came back itself, so what's saved as built passed here.
 */
export async function* build(req: BuildRequest, signal: AbortSignal): AsyncIterable<BuildEvent> {
  const template = await vizTemplate();
  const files: Record<string, string> = {
    ...template.files,
    'SPEC.md': req.title ? `# ${req.title}\n\n${req.spec.trim()}\n` : `${req.spec.trim()}\n`,
    'package.json': packagesJson(req.packages),
  };
  if (req.source?.trim()) files['viz.ts'] = req.source;
  const own = Object.fromEntries(Object.entries(req.files).map(([name, b64]) => [`files/${name}`, b64]));
  const bytes = Object.fromEntries(Object.entries(own).map(([p, b64]) => [p, fromBase64(b64)]));
  const prompt = req.source?.trim()
    ? 'Build the visualization SPEC.md describes, starting from the previous version in viz.ts: keep what works and change what the spec requires.'
    : 'Build the visualization SPEC.md describes.';

  const made: Record<string, string> = { 'package.json': files['package.json'] };
  if (files['viz.ts']) made['viz.ts'] = files['viz.ts'];
  const start = { workspace: req.viz, prompt, system: SYSTEM, files, binary: { ...template.binary, ...own }, keep: KEEP };
  for await (const e of runOnBridge(AGENT_NODE, start, [vizCheckTool(bytes)], signal)) {
    if (e.type === 'files') {
      for (const [p, t] of Object.entries(e.files)) {
        if (t === null) delete made[p];
        else made[p] = t;
      }
    } else if (e.type !== 'done') {
      yield e;
    }
  }
  if (signal.aborted || !made['viz.ts']) { yield { type: 'done' }; return; }

  yield { type: 'tool', name: 'check', summary: 'what came back, here' };
  const [{ checkViz, packagesOf }, { browserPlatform }] = await Promise.all([import('@gestalts/check'), import('@gestalts/check/browser')]);
  const r = await checkViz({ ...bytes, ...made }, browserPlatform);
  const packages = Object.entries(packagesOf(made['package.json']).packages).map(([n, v]) => `${n}@${v}`);
  yield {
    type: 'result', ok: r.ok, check: r.report, generator: GENERATOR, source: made['viz.ts'], packages,
    built: r.built, still: r.still ? toBase64(r.still) : undefined,
  };
  yield { type: 'done' };
}

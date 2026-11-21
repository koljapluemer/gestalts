import type { CheckResult, Files } from '@gestalts/check';

/**
 * What an agent may do besides thinking: the app's tools, the same whichever model runs the loop. The claude CLI gets
 * them through the bridge (each call comes back to the page); an agent loop in the page would call them directly.
 */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** runs on the draft's files as they are now */
  run(input: unknown, files: Record<string, string>): Promise<ToolResult>;
};

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A check's result as a tool's: the report, then each screenshot. Failing is an error, so the agent goes on. */
export function checkResult(r: CheckResult): ToolResult {
  return {
    content: [{ type: 'text', text: r.report }, ...r.shots.map((s) => ({ type: 'image' as const, data: base64(s.png), mimeType: 'image/png' }))],
    isError: !r.ok,
  };
}

const fail = (e: unknown): ToolResult => ({ content: [{ type: 'text', text: `the check couldn't run: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/** The workshop's check of a draft view, in this page. `gestalts`: those the app has. */
export function viewCheckTool(gestalts: string[]): AgentTool {
  return {
    name: 'check',
    description: 'Compiles and typechecks view.tsx as the workshop does, checks view.json, gestalts/ and data/, and that each npm import is pinned in view.json. Run it before you finish.',
    inputSchema: NO_INPUT,
    async run(_input, files) {
      try {
        const [{ checkView }, { browserPlatform }] = await Promise.all([import('@gestalts/check'), import('@gestalts/check/browser')]);
        return checkResult(await checkView(files, { gestalts }, browserPlatform));
      } catch (e) {
        return fail(e);
      }
    },
  };
}

/** A viz's check, in this page; `extra` are its `files/` (bytes), which the agent can't change. */
export function vizCheckTool(extra: Files): AgentTool {
  return {
    name: 'check',
    description: 'Typechecks viz.ts, runs its checks, builds the page (with the packages in package.json) and renders it at 360 and 1000 px, light and dark, with the network blocked. Returns what failed and a screenshot of each. Run it before you finish.',
    inputSchema: NO_INPUT,
    async run(_input, files) {
      try {
        const [{ checkViz }, { browserPlatform }] = await Promise.all([import('@gestalts/check'), import('@gestalts/check/browser')]);
        return checkResult(await checkViz({ ...extra, ...files }, browserPlatform));
      } catch (e) {
        return fail(e);
      }
    },
  };
}

/**
 * Reading and changing a draft held in the page, for an agent loop that runs here (a model behind an API). `files` is
 * changed in place; `writable` says which paths it may write. Not used by the CLI, which edits its workspace itself.
 */
export function fileTools(files: Record<string, string>, writable: RegExp): AgentTool[] {
  const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });
  const arg = (input: unknown, k: string) => (input && typeof input === 'object' ? (input as Record<string, unknown>)[k] : undefined);
  const path = { type: 'string', description: 'e.g. view.tsx, data/haus.yml' };
  return [
    { name: 'list_files', description: 'Lists the files.', inputSchema: NO_INPUT, run: async () => text(Object.keys(files).sort().join('\n')) },
    {
      name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object', properties: { path }, required: ['path'] },
      run: async (input) => { const p = String(arg(input, 'path')); return p in files ? text(files[p]) : text(`no file ${p}`, true); },
    },
    {
      name: 'write_file', description: 'Writes a whole file.', inputSchema: { type: 'object', properties: { path, content: { type: 'string' } }, required: ['path', 'content'] },
      run: async (input) => {
        const p = String(arg(input, 'path'));
        if (!writable.test(p)) return text(`${p} can't be written`, true);
        files[p] = String(arg(input, 'content') ?? '');
        return text(`wrote ${p}`);
      },
    },
    {
      name: 'edit_file', description: 'Replaces `old_string`, which must occur once, with `new_string`.',
      inputSchema: { type: 'object', properties: { path, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
      run: async (input) => {
        const p = String(arg(input, 'path'));
        const [from, to] = [String(arg(input, 'old_string') ?? ''), String(arg(input, 'new_string') ?? '')];
        if (!writable.test(p) || !(p in files)) return text(`${p} can't be edited`, true);
        if (files[p].split(from).length !== 2) return text(`old_string must occur exactly once in ${p}`, true);
        files[p] = files[p].replace(from, () => to);
        return text(`edited ${p}`);
      },
    },
  ];
}

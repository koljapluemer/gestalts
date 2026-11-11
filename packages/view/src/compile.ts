/**
 * A view's one file to the module the frame runs: TypeScript and JSX out, ES imports kept. The same for views in
 * source (at build time) and vibecoded ones (in the browser), so there is one way a view runs.
 */
import { transform } from 'sucrase';

/** What the frame's runtime provides; any other bare import is fetched from npm. */
export const RUNTIME_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react', '@gestalts/view', '@gestalts/kit', '@gestalts/learning', '@gestalts/sources'] as const;

export type CompileError = { message: string; line?: number; column?: number };
export type Compiled = { ok: true; js: string; npm: string[] } | { ok: false; errors: CompileError[] };

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n;]*?\bfrom\s+)?(['"])([^'"\n]+)\1/g;
const runtime: readonly string[] = RUNTIME_MODULES;

export function compile(source: string, filePath = 'view.tsx'): Compiled {
  let js: string;
  try {
    js = transform(source, { transforms: ['typescript', 'jsx'], jsxRuntime: 'automatic', production: true, filePath }).code;
  } catch (e) {
    const err = e as { message?: string; loc?: { line: number; column: number } };
    return { ok: false, errors: [{ message: err.message ?? String(e), line: err.loc?.line, column: err.loc?.column }] };
  }
  const imports = [...new Set([...js.matchAll(IMPORT)].map((m) => m[2]))];
  const errors: CompileError[] = imports.filter((i) => i.startsWith('.') || i.startsWith('/')).map((i) => ({ message: `cannot import ${JSON.stringify(i)}: a view is one file` }));
  if (!/\bexport\s+default\b/.test(js)) errors.push({ message: 'a view needs a default export: the React component to show' });
  return errors.length ? { ok: false, errors } : { ok: true, js, npm: imports.filter((i) => !runtime.includes(i)) };
}

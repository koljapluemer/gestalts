import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';

/** The app's areas, by path. */
export const AREAS = [
  { path: '/notes', title: 'Notes' },
  { path: '/learn', title: 'Learn' },
  { path: '/viz', title: 'Visualizations' },
  { path: '/make', title: 'Learning workshop' },
  { path: '/make-viz', title: 'vizint workshop' },
  { path: '/teach', title: 'Lessons' },
] as const;
export type AreaPath = (typeof AREAS)[number]['path'];
const HOME: AreaPath = '/notes';

const listeners = new Set<() => void>();
const areaOf = (pathname: string): AreaPath => AREAS.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`))?.path ?? HOME;

/** Goes to `path` (an area), keeping what follows it (a view's `#hash`) out: each area starts from its own. */
export function navigate(path: AreaPath) {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

/** The area shown: from the path, `/notes` for anything else (and the path made to say so). */
export function useArea(): AreaPath {
  const [area, setArea] = useState(() => areaOf(location.pathname));
  useEffect(() => {
    const update = () => setArea(areaOf(location.pathname));
    listeners.add(update);
    addEventListener('popstate', update);
    if (location.pathname !== areaOf(location.pathname)) history.replaceState(null, '', `${areaOf(location.pathname)}${location.hash}`);
    return () => { listeners.delete(update); removeEventListener('popstate', update); };
  }, []);
  return area;
}

/** A link to an area; a plain link for a new tab and the like. */
export function AreaLink({ path, className, children }: { path: AreaPath; className?: string; children: ReactNode }) {
  const go = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
    navigate(path);
  };
  return <a href={path} className={className} onClick={go}>{children}</a>;
}

/** The other areas, from each area's header: at its start, or at its `end`. */
export function Areas({ end = false }: { end?: boolean }) {
  const here = useArea();
  return (
    <details className={`dropdown ${end ? 'dropdown-end' : ''}`}>
      <summary className="btn btn-sm btn-ghost btn-square" title="Areas"><LayoutGrid className="size-4" /></summary>
      <ul className="dropdown-content menu z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        {AREAS.map((a) => <li key={a.path}><AreaLink path={a.path} className={a.path === here ? 'menu-active' : ''}>{a.title}</AreaLink></li>)}
      </ul>
    </details>
  );
}

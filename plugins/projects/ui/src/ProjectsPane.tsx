import { useState } from 'react';
import { Hammer, Lightbulb, Plus } from 'lucide-react';
import { definePane, definePerspective, useHost, type IndexedNote, type Query } from '@gestalts/sdk';
import { Note, type TagToggle } from '@gestalts/kit';
import { group, issueSeed, ISSUES, PROJECTS, THINK_TAG } from './projects';

const THINK: TagToggle[] = [{
  tag: THINK_TAG, icon: Hammer, activeIcon: Lightbulb, title: 'to build (click: to think about)', activeTitle: 'to think about (click: to build)',
}];

const OPEN_KEY = 'gestalts-projects-open';

/** Keys of the expanded projects; storage can be unavailable or hold garbage, then all start collapsed. */
function readOpen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch { return new Set(); }
}

/** Remembers which projects are expanded across reloads. */
function useOpenProjects() {
  const [open, setOpen] = useState(readOpen);
  const toggle = (key: string, isOpen: boolean) => {
    if (open.has(key) === isOpen) return;
    const next = new Set(open);
    if (isOpen) next.add(key); else next.delete(key);
    setOpen(next);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* not remembered */ }
  };
  return { open, toggle };
}

/**
 * Projects (tag `project`), each expandable to its issues (tag `issue`, related to it by `project`), and the issues
 * belonging to none; all inline. + Project and a project's + issue open a new note; issues to think about come first.
 */
const Projects = definePerspective<{ projects: Query; issues: Query }>({
  id: 'projects',
  title: 'Projects',
  data: { projects: PROJECTS, issues: ISSUES },
  Component: ({ data }) => {
    const host = useHost();
    const { open, toggle } = useOpenProjects();
    const grouped = group(data.projects, data.issues);
    const create = host.createNote;
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-2 p-3">
        {create && (
          <button type="button" className="btn btn-sm self-start" onClick={() => void create({ gestalt: 'project@1', preset: 'gestalt' })}>
            <Plus className="size-4" />Project
          </button>
        )}
        {!grouped.projects.length && <p className="text-base-content/50">No projects.</p>}
        {grouped.projects.map(({ project, issues }) => (
          <details key={project.key} className="collapse collapse-arrow border border-base-300"
                   open={open.has(project.key)} onToggle={(e) => toggle(project.key, e.currentTarget.open)}>
            <summary className="collapse-title font-semibold">
              <Note noteKey={project.key} render="inline" onOpen={host.openNote} extraTools={[
                { key: 'count', node: <span className="badge badge-ghost badge-sm font-normal" title="issues">{issues.length}</span> },
                ...(create ? [{ key: 'issue', title: 'add an issue', icon: <Plus className="size-3.5" />, onClick: () => void create(issueSeed(project)) }] : []),
              ]} />
            </summary>
            <div className="collapse-content"><IssueList issues={issues} onOpen={host.openNote} /></div>
          </details>
        ))}
        {grouped.orphans.length > 0 && (
          <div className="mt-4">
            <h2 className="mb-1 font-semibold">Issues without a project</h2>
            <p className="mb-2 text-sm text-base-content/50">An issue belongs to the projects its <code>project</code> relationships point to.</p>
            <IssueList issues={grouped.orphans} onOpen={host.openNote} />
          </div>
        )}
      </div>
    );
  },
});

function IssueList({ issues, onOpen }: { issues: IndexedNote[]; onOpen?: (key: string) => void }) {
  if (!issues.length) return <p className="text-sm text-base-content/50">No issues.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((i) => <li key={i.key}><Note noteKey={i.key} render="inline" tagToggles={THINK} onOpen={onOpen} className="px-2 py-1" /></li>)}
    </ul>
  );
}

export const ProjectsPane = definePane({ title: 'Projects', Component: () => <Projects /> });

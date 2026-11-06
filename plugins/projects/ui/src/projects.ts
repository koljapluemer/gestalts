import { noteLabel, relationships, tags, type IndexedNote, type NoteSeed, type Query } from '@gestalts/sdk';

/** A note shown as a project (`project@1`). */
export const PROJECT_TAG = 'project';
/** A note shown as an issue; it belongs to the projects its `project` relationships point to (`issue@1`). */
export const ISSUE_TAG = 'issue';
export const PROJECT_RELATION = 'project';
/** An issue to think about (and sketch) rather than build; listed first. dsl's tag, so its notes keep their meaning. */
export const THINK_TAG = 'suggest-think-and-sketch';

/** By tag, not by gestalt: an issue with no project lacks `issue@1`'s relationship, and is still listed. */
export const PROJECTS: Query = { tagsAll: [PROJECT_TAG] };
export const ISSUES: Query = { tagsAll: [ISSUE_TAG] };

export type ProjectGroup = { project: IndexedNote; issues: IndexedNote[] };

const byLabel = (a: IndexedNote, b: IndexedNote) =>
  noteLabel(a).toLowerCase().localeCompare(noteLabel(b).toLowerCase()) || a.key.localeCompare(b.key);
const thinkFirst = (a: IndexedNote, b: IndexedNote) =>
  Number(!tags(a).includes(THINK_TAG)) - Number(!tags(b).includes(THINK_TAG)) || byLabel(a, b);

/**
 * Every project with the issues belonging to it (an issue in several projects under each), by label, and the issues
 * belonging to none of them (no `project` relationship, or only to notes that aren't projects); issues to think about
 * first, then by label.
 */
export function group(projects: readonly IndexedNote[], issues: readonly IndexedNote[]): { projects: ProjectGroup[]; orphans: IndexedNote[] } {
  const owned = new Map<string, IndexedNote[]>(projects.map((p) => [p.id, []]));
  const orphans: IndexedNote[] = [];
  for (const issue of issues) {
    const targets = new Set(relationships(issue).filter((r) => r.label === PROJECT_RELATION && owned.has(r.target)).map((r) => r.target));
    for (const t of targets) owned.get(t)!.push(issue);
    if (!targets.size) orphans.push(issue);
  }
  return {
    projects: [...projects].sort(byLabel).map((project) => ({ project, issues: owned.get(project.id)!.sort(thinkFirst) })),
    orphans: orphans.sort(thinkFirst),
  };
}

/** A new issue belonging to `project`. */
export const issueSeed = (project: IndexedNote): NoteSeed => ({
  gestalt: 'issue@1', value: { relationships: [{ to: project.id, label: PROJECT_RELATION }] }, preset: 'gestalt',
});

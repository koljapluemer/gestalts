/** How a note is shown: rendered, its editor, or (for the text) both side by side. */
export type NoteMode = 'view' | 'edit' | 'split';

export const ALL_MODES: readonly NoteMode[] = ['view', 'edit', 'split'];

export const isMode = (value: unknown): value is NoteMode => ALL_MODES.includes(value as NoteMode);

/** The mode to show: `wanted` when it's offered, else `fallback` when it is, else the first one offered. */
export function resolveMode(offered: readonly NoteMode[], wanted: NoteMode | undefined, fallback: NoteMode): NoteMode {
  if (wanted && offered.includes(wanted)) return wanted;
  return offered.includes(fallback) ? fallback : offered[0];
}

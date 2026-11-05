import type { ReactNode } from 'react';
import { Columns2, Eye, PenLine, type LucideIcon } from 'lucide-react';
import type { NoteMode } from './mode';

/** The note's own tools; each shows where it applies unless switched off (`Note`'s `tools`). */
export type ToolId = 'media' | 'reference' | 'addGestalt' | 'source' | 'edit' | 'delete';

/** A tag the note toggles: `icon` while it's off, `activeIcon` (else `icon`, highlighted) while it's on. */
export type TagToggle = { tag: string; icon: LucideIcon; activeIcon?: LucideIcon; title: string; activeTitle?: string };

/** A page's own tool in the note's tool row: a button like the note's, or any control (`node`). */
export type ExtraTool =
  | { key: string; title: string; icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }
  | { key: string; node: ReactNode };

/** Every tool's look: an icon, small, ghost. */
export const TOOL = 'btn btn-ghost btn-xs btn-square';

export function ToolButton({ title, onClick, disabled, active, danger, children }: {
  title: string; onClick: () => void; disabled?: boolean; active?: boolean; danger?: boolean; children: ReactNode;
}) {
  return (
    // the mouse doesn't take the focus from an editor (whose blur would save); the click isn't the card's
    <button type="button" className={`nodrag ${TOOL} ${active ? 'btn-active text-primary' : ''} ${danger ? 'hover:text-error' : ''}`} title={title}
            aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

const MODE_ICONS: Record<NoteMode, { Icon: LucideIcon; title: string }> = {
  view: { Icon: Eye, title: 'Read' },
  edit: { Icon: PenLine, title: 'Edit' },
  split: { Icon: Columns2, title: 'Edit, with the text rendered beside it' },
};

/** The modes offered, to switch between; nothing when there's only one. */
export function ModeToggle({ modes, mode, onMode }: { modes: readonly NoteMode[]; mode: NoteMode; onMode: (mode: NoteMode) => void }) {
  if (modes.length < 2) return null;
  return (
    <div className="join" role="group" aria-label="Mode">
      {modes.map((m) => {
        const { Icon, title } = MODE_ICONS[m];
        return (
          <button key={m} type="button" className={`nodrag btn join-item btn-xs btn-square ${m === mode ? 'btn-active' : 'btn-ghost'}`} title={title}
                  aria-pressed={m === mode} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onMode(m); }}>
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}

export function Extra({ tool }: { tool: ExtraTool }) {
  if ('node' in tool) return <>{tool.node}</>;
  return <ToolButton title={tool.title} onClick={tool.onClick} disabled={tool.disabled} danger={tool.danger}>{tool.icon}</ToolButton>;
}

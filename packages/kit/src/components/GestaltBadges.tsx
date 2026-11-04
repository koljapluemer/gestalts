import { CircleAlert } from 'lucide-react';
import type { Lint } from '@gestalts/sdk';

/** The gestalts a note has, plus how many rules it breaks for those it almost has. */
export function GestaltBadges({ gestalts, lints }: { gestalts: string[]; lints: Lint[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {gestalts.map((g) => <span key={g} className="badge badge-sm badge-primary badge-soft">{g}</span>)}
      {lints.length > 0 && (
        <span className="badge badge-sm badge-warning badge-soft gap-1" title={lints.map((l) => `${l.gestalt} ${l.path}: ${l.message}`).join('\n')}>
          <CircleAlert className="size-3" /> {lints.length}
        </span>
      )}
      {!gestalts.length && !lints.length && <span className="text-xs text-base-content/50">no gestalt</span>}
    </div>
  );
}

import { asMap, fold, relationships, type Hashing, type IndexedNote } from '@gestalts/sdk';
import type { Facet, FsrsStates } from './learning';

/**
 * The flashcards to learn, from every note, and which one comes next (as dsl's Learn tab). Pure: hashing is passed in
 * (`hashing` from the client in the app).
 *
 * A card is reviewed as one facet of the note it belongs to (`facet` = its card id), so its state stays the same when
 * an attached `flashcard@1` (`card-of`) is folded into its host's `cards`. A `flashcard@1` of its own is reviewed as
 * the whole note.
 */

export type LearnCard = {
  facet: Facet;
  front: string;
  back: string;
  /** the note to open for it: the host, else the card note */
  noteKey: string;
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const hostOf = (n: IndexedNote) => relationships(n).find((r) => r.label === fold.ATTACHED_LABEL.cards)?.target;

/** `slot` of a facet, to compare two cards. */
export const slotOf = (f: Facet) => `${f.target}\u0000${f.facet ?? ''}`;

/**
 * Every card: the `cards` of `hosts`, then each `flashcard@1` in `flashcards` (retired ones left out by the caller).
 * Attached ones count for their host unless it has the `cards` key (which wins, as in `readCards`). A facet that
 * occurs twice (the same front twice in a note) is one card, the first.
 */
export function learnableCards(hosts: IndexedNote[], flashcards: IndexedNote[], h: Hashing): LearnCard[] {
  const out: LearnCard[] = [];
  const seen = new Set<string>();
  const add = (c: LearnCard) => {
    const s = slotOf(c.facet);
    if (seen.has(s)) return;
    seen.add(s);
    out.push(c);
  };
  const hostById = new Map<string, IndexedNote>();
  for (const host of hosts) {
    hostById.set(host.id, host);
    for (const c of fold.readCards(host, [], h).value ?? []) add({ facet: { target: host.id, facet: c.id }, front: c.front, back: c.back, noteKey: host.key });
  }
  for (const n of flashcards) {
    const v = asMap(n.value) ?? {};
    const front = text(v.front);
    const back = text(v.back);
    const hostId = hostOf(n);
    if (!hostId) {
      add({ facet: { target: n.id }, front, back, noteKey: n.key });
      continue;
    }
    const host = hostById.get(hostId);
    if (host && fold.hasKey(host, 'cards')) continue;
    add({ facet: { target: hostId, facet: h.cardId(front) }, front, back, noteKey: host?.key ?? n.key });
  }
  return out;
}

export type Pick<C> = {
  card: C | null;
  counts: { due: number; new: number; total: number };
  /** the earliest due time of the cards not due yet */
  nextDue: string | null;
};

/**
 * A random due card, else a random new one (never reviewed), never `last` unless it's the only one to pick from.
 * `card` is null when nothing is due or new.
 */
export function pickNext<C extends { facet: Facet }>(cards: C[], states: FsrsStates, last: string | null, now: Date, random: () => number = Math.random): Pick<C> {
  const due: C[] = [];
  const fresh: C[] = [];
  let nextDue: number | null = null;
  for (const c of cards) {
    const s = states.get(c.facet);
    if (!s) { fresh.push(c); continue; }
    const at = Date.parse(s.card.dueAt);
    if (!(at > now.getTime())) due.push(c);
    else if (nextDue === null || at < nextDue) nextDue = at;
  }
  const notLast = (pool: C[]) => pool.filter((c) => slotOf(c.facet) !== last);
  const pool = [notLast(due), notLast(fresh), due, fresh].find((p) => p.length) ?? [];
  return {
    card: pool.length ? pool[Math.floor(random() * pool.length)] : null,
    counts: { due: due.length, new: fresh.length, total: cards.length },
    nextDue: nextDue === null ? null : new Date(nextDue).toISOString(),
  };
}

/** How long until `iso`, rounded down to its largest unit: `<1m`, `10m`, `3h`, `4d`, `2mo`, `1.5y`. */
export function until(iso: string, now = Date.now()): string {
  const minutes = (Date.parse(iso) - now) / 60_000;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 36.5) / 10}y`;
}

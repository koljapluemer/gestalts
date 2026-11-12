import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Expand } from 'lucide-react';
import { facetOf, fsrsStates, practiceEvent, type FsrsStates } from '@gestalts/learning';
import { useCapabilities, useDoc, useLlm, useNet, useQuery, useViewState, useWrite, type Item, type JsonMap, type NetResponse, type QueryResult } from '@gestalts/view';

/**
 * Watch a YouTube video with cards for the words worth knowing as they come up (after transparent-input). Subtitles
 * come through the app's `net`, glosses from the user's LLM providers, a few segments ahead of playback, kept in a
 * `glossed-track@1` so a video is glossed once. Each word shown is a `concept@2` per flemma (its base form with all
 * inflections, whatever the part of speech), which the video links with a small strength, and showing it logs a rating-0
 * `practice-event@1` with that concept as its subject and the video as its origin. Words whose flashcard is well
 * learned get no cards; due ones stand out.
 */

// ---------- YouTube: ids, subtitle tracks, cues ----------

export type RawCue = { start: number; end: number; text: string };
export type SubtitleTrack = { languageCode: string; name: string; baseUrl: string; asr: boolean };

/** The video id in a YouTube URL, or a bare id. */
export function videoIdFrom(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const id = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0]
    : host === 'youtube.com' || host === 'youtube-nocookie.com'
      ? url.searchParams.get('v') ?? /^\/(?:embed|shorts|live)\/([\w-]{11})/.exec(url.pathname)?.[1] ?? null
      : null;
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export function parseJson3(json3: { events?: { segs?: { utf8?: string }[]; tStartMs?: number; dDurationMs?: number }[] }): RawCue[] {
  const cues: RawCue[] = [];
  for (const event of json3.events ?? []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (event.tStartMs ?? 0) / 1000;
    cues.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text });
  }
  return cues;
}

type Net = (r: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<NetResponse>;

// Public, non-secret Innertube key in every youtube.com page; the WEB client needs it, the ANDROID one doesn't.
const WEB_INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const CLIENTS = [
  { url: 'https://www.youtube.com/youtubei/v1/player', client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
  // the ANDROID client sometimes leaves out auto-generated tracks that the WEB client lists
  { url: `https://www.youtube.com/youtubei/v1/player?key=${WEB_INNERTUBE_KEY}`, client: { clientName: 'WEB', clientVersion: '2.20240111.09.00', hl: 'en' } },
];

type PlayerResponse = {
  videoDetails?: { title?: string };
  playabilityStatus?: { status?: string; reason?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { languageCode: string; name?: { simpleText?: string; runs?: { text: string }[] }; baseUrl: string; kind?: string }[] } };
};

/** The video's title and subtitle tracks, as YouTube's own apps ask for them. */
export async function lookUpVideo(net: Net, videoId: string): Promise<{ title: string | null; tracks: SubtitleTrack[] }> {
  let title: string | null = null;
  let reason = 'it has no subtitles';
  for (const { url, client } of CLIENTS) {
    const r = await net({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: { client }, videoId, contentCheckOk: true, racyCheckOk: true }) });
    if (r.status !== 200) { reason = `YouTube answered ${r.status}`; continue; }
    const data = JSON.parse(r.text()) as PlayerResponse;
    title ??= data.videoDetails?.title ?? null;
    const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length) {
      return { title, tracks: tracks.map((t) => ({ languageCode: t.languageCode, name: t.name?.simpleText ?? t.name?.runs?.map((x) => x.text).join('') ?? languageName(t.languageCode), baseUrl: t.baseUrl, asr: t.kind === 'asr' })) };
    }
    if (data.playabilityStatus?.reason) reason = data.playabilityStatus.reason;
  }
  throw new Error(`No subtitles found for this video (${reason}).`);
}

export async function fetchCues(net: Net, track: SubtitleTrack): Promise<RawCue[]> {
  const url = track.baseUrl.replace(/[&?]fmt=[^&]*/g, '') + '&fmt=json3';
  const r = await net({ url });
  if (r.status !== 200) throw new Error(`YouTube answered ${r.status} for the subtitles`);
  const cues = parseJson3(JSON.parse(r.text()) as Parameters<typeof parseJson3>[0]);
  if (!cues.length) throw new Error('The subtitles are empty.');
  return cues;
}

// ---------- segments: cues joined into pieces worth glossing (transparent-input's segmentation) ----------

export type MetaSegment = { start: number; end: number; text: string };

const MIN_WORDS = 8;
const IDEAL_MIN_WORDS = 12;
const IDEAL_MAX_WORDS = 25;
const MAX_WORDS = 50;
const countWords = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/** Splits the cues into segments of about 12 to 25 words, preferring cuts where cues don't overlap. */
export function buildMetaSegments(cues: RawCue[]): MetaSegment[] {
  if (!cues.length) return [];
  const words = cues.map((c) => countWords(c.text));
  const prefix = [0];
  for (const w of words) prefix.push(prefix[prefix.length - 1] + w);
  const n = cues.length;
  const best: number[] = Array.from({ length: n + 1 }, () => Infinity);
  const next: (number | null)[] = Array.from({ length: n + 1 }, () => null);
  best[n] = 0;
  const wordCost = (wc: number) => {
    if (wc >= IDEAL_MIN_WORDS && wc <= IDEAL_MAX_WORDS) return 0;
    const d = wc < IDEAL_MIN_WORDS ? IDEAL_MIN_WORDS - wc : wc - IDEAL_MAX_WORDS;
    return (d * d) / 4;
  };
  const cutCost = (l: RawCue, r: RawCue) => { const overlap = Math.max(0, l.end - r.start); return overlap <= 0 ? 0 : 5 + overlap * 40; };
  for (let start = n - 1; start >= 0; start--) {
    for (let end = start; end < n; end++) {
      const wc = prefix[end + 1] - prefix[start];
      if (wc > MAX_WORDS) break;
      if (wc < MIN_WORDS) continue;
      const cost = wordCost(wc) + (end + 1 < n ? cutCost(cues[end], cues[end + 1]) : 0) + best[end + 1];
      if (cost < best[start]) { best[start] = cost; next[start] = end + 1; }
    }
  }
  const join = (slice: RawCue[]) => ({ start: slice[0].start, end: slice[slice.length - 1].end, text: slice.map((c) => c.text).join(' ').replace(/\s+/g, ' ') });
  if (next[0] === null) return [join(cues)];
  const out: MetaSegment[] = [];
  for (let i = 0; i < n;) {
    const j = next[i];
    if (j === null) break;
    out.push(join(cues.slice(i, j)));
    i = j;
  }
  return out;
}

// ---------- glossing ----------

export type Gloss = { surface: string; flemma: string; translation: string };
export type GlossedSegment = MetaSegment & { glosses: Gloss[] };

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
export function languageName(code: string): string {
  try { return languageNames.of(code) ?? code; } catch { return code; }
}

export function glossPrompt(segment: string, language: string, native: string): string {
  const target = languageName(language);
  const mother = languageName(native);
  return `You are helping a ${mother} speaker understand a ${target} subtitle segment.\n`
    + 'Extract only the core words, short expressions, or constructions needed to understand the segment. Do not include full sentences. '
    + 'Do not include guesses, conjectures, "maybe it means X" or words where you don\'t know the translation. '
    + `Do not include words that are the same in ${target} and ${mother}.\n`
    + `For each item give "surface": exactly as it appears in the segment; "flemma": its base form in ${target}, the one `
    + 'form that stands for all its inflections whatever its part of speech (as a dictionary headword, without articles; '
    + `for an expression, the expression in its base form); "translation": into ${mother}.\n`
    + 'Return JSON: {"vocab": [{"surface": "...", "flemma": "...", "translation": "..."}]}\n\n'
    + `Subtitle segment:\n${segment}`;
}

/** The glosses in an answer; null when it isn't the shape asked for. */
export function parseGlosses(text: string): Gloss[] | null {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return null; }
  const vocab = (payload as { vocab?: unknown } | null)?.vocab;
  if (!Array.isArray(vocab)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return vocab.flatMap((v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const g = { surface: str(o.surface), flemma: str(o.flemma) || str(o.surface), translation: str(o.translation) };
    return g.surface && g.translation ? [g] : [];
  });
}

/** Indexes of the segment playing at `time` (or, between segments, the next) and the few after it. */
export function lookahead(segments: MetaSegment[], time: number, count = 4): number[] {
  const first = segments.findIndex((s) => s.end > time);
  if (first === -1) return [];
  return Array.from({ length: Math.min(count, segments.length - first) }, (_, i) => first + i);
}

const IN_FLIGHT = 2;

/**
 * Glosses the segments just ahead of playback, at most two at a time, so the cost follows what is watched. A segment
 * that failed is tried again once playback leaves it and comes back.
 */
class Glosser {
  private inFlight = new Set<number>();
  private failed = new Set<number>();
  stopped: string | null = null;

  constructor(private segments: MetaSegment[], private done: (start: number) => boolean,
              private gloss: (s: MetaSegment) => Promise<Gloss[]>, private onError: (message: string, fatal: boolean) => void) {}

  tick(time: number) {
    if (this.stopped) return;
    const window = lookahead(this.segments, time);
    for (const i of this.failed) if (!window.includes(i)) this.failed.delete(i);
    for (const i of window) {
      if (this.inFlight.size >= IN_FLIGHT) break;
      const s = this.segments[i];
      if (this.done(s.start) || this.inFlight.has(i) || this.failed.has(i)) continue;
      this.inFlight.add(i);
      this.gloss(s).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        // without a node or a provider, every segment would fail alike
        const fatal = /no LLM provider is set up|needs the desktop app/.test(message);
        if (fatal) this.stopped = message;
        this.failed.add(i);
        this.onError(message, fatal);
      }).finally(() => this.inFlight.delete(i));
    }
  }
}

// ---------- what the learner knows ----------

/** A concept per flemma of a language, named like the decks name theirs (`grc:κιννάμωμον`). */
export const conceptName = (language: string, flemma: string) => `${language.split('-')[0].toLowerCase()}:${flemma.normalize('NFC').trim()}`;

/** How strongly seeing a word's card while watching practises it. */
export const EXPOSURE_STRENGTH = 0.05;

/** The video's yml with `concepts` linked at `strength`, keeping links it has; null when there's nothing new. */
export function withConcepts(value: JsonMap, concepts: string[], strength = EXPOSURE_STRENGTH): JsonMap | null {
  const had = (value.concepts ?? {}) as Record<string, number>;
  const fresh = concepts.filter((c) => !(c in had));
  if (!fresh.length) return null;
  return { ...value, concepts: { ...had, ...Object.fromEntries(fresh.map((c) => [c, strength])) } };
}

/** Same rule as the decks' builders: `concept-` and the first 16 hex digits of the name's sha256. */
async function conceptId(hash: (b: Uint8Array) => Promise<string>, name: string): Promise<string> {
  return `concept-${(await hash(new TextEncoder().encode(name))).slice(0, 16)}`;
}

/** Well enough learned to need no card while watching. */
const STABLE_DAYS = 21;

export type Standing = 'new' | 'due' | 'hidden';

/** How a word stands by the flashcard that practises it: well learned (hidden), due (due), or anything else (new). */
export function standing(concept: string | undefined, cardOf: Map<string, string>, states: FsrsStates, now: Date): Standing {
  if (!concept) return 'new';
  const card = cardOf.get(concept);
  const s = card ? states.get(facetOf(card)) : undefined;
  if (!s) return 'new';
  if (typeof s.card.stability === 'number' && s.card.stability >= STABLE_DAYS) return 'hidden';
  return Date.parse(s.card.dueAt) <= now.getTime() ? 'due' : 'new';
}

// ---------- cards on screen (transparent-input's timing) ----------

const CARD_MS = 4000;
const MAX_CARDS = 3;
const MIN_GAP_S = 1;
const MAX_GAP_S = 3;

export type ShownCard = { key: number; gloss: Gloss; standing: Standing; expireAt: number };

export function segmentAt(segments: GlossedSegment[], time: number): number {
  return segments.findIndex((s) => time >= s.start && time < s.end);
}

/** The next gloss to show: due words first, then new ones; never a hidden one or one on screen. */
export function pickGloss(glosses: Gloss[], onScreen: Set<string>, standingOf: (g: Gloss) => Standing, random = Math.random): Gloss | null {
  const open = glosses.filter((g) => !onScreen.has(g.surface) && standingOf(g) !== 'hidden');
  const due = open.filter((g) => standingOf(g) === 'due');
  const from = due.length ? due : open;
  return from.length ? from[Math.floor(random() * from.length)] : null;
}

// ---------- the player: YouTube's embed, driven over its postMessage protocol (no Google script runs here) ----------

const YT_ORIGINS = new Set(['https://www.youtube.com', 'https://www.youtube-nocookie.com']);
const PLAYING = 1;

class YouTubePlayer {
  private handshake: ReturnType<typeof setInterval> | undefined;
  private time = 0;
  private timeAt = 0;
  state = -1;

  constructor(private frame: HTMLIFrameElement) {
    addEventListener('message', this.onMessage);
    // the player answers only once loaded; the official API says it listens until it does, and so do we
    this.handshake = setInterval(() => this.post({ event: 'listening', id: 1, channel: 'widget' }), 250);
  }

  private post(msg: object) { this.frame.contentWindow?.postMessage(JSON.stringify(msg), '*'); }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow || !YT_ORIGINS.has(e.origin) || typeof e.data !== 'string') return;
    let msg: { event?: string; info?: unknown };
    try { msg = JSON.parse(e.data) as typeof msg; } catch { return; }
    if (msg.event === 'onReady' || msg.event === 'initialDelivery') clearInterval(this.handshake);
    if ((msg.event === 'infoDelivery' || msg.event === 'initialDelivery') && msg.info && typeof msg.info === 'object') {
      const info = msg.info as { currentTime?: number; playerState?: number };
      if (typeof info.currentTime === 'number') { this.time = info.currentTime; this.timeAt = performance.now(); }
      if (typeof info.playerState === 'number') this.state = info.playerState;
    }
    if (msg.event === 'onStateChange' && typeof msg.info === 'number') this.state = msg.info;
  };

  /** Seconds into the video, run on from the last report while playing. */
  currentTime(): number { return this.state === PLAYING ? this.time + (performance.now() - this.timeAt) / 1000 : this.time; }
  playing(): boolean { return this.state === PLAYING; }
  command(func: string, args: unknown[] = []) { this.post({ event: 'command', func, args, id: 1, channel: 'widget' }); }

  destroy() {
    clearInterval(this.handshake);
    removeEventListener('message', this.onMessage);
  }
}

// ---------- the view ----------

/** Every page of a query: the view needs all of them to decide. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}

const browserLanguage = () => (navigator.language || 'en').split('-')[0];

export default function TransparentInput() {
  const [open, setOpen] = useViewState<string | null>('open', null);
  const [native, setNative] = useViewState<string>('native', browserLanguage());
  return open
    ? <Player key={`${open}:${native}`} sourceId={open} native={native} setNative={setNative} onBack={() => setOpen(null)} />
    : <Library native={native} setNative={setNative} onOpen={setOpen} />;
}

/** Every language the browser can name by a two-letter code, by name. Other codes (`gsw`, `pt-BR`) can be typed. */
export function knownLanguages(): { code: string; name: string }[] {
  const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const out: { code: string; name: string }[] = [];
  for (const a of letters) for (const b of letters) {
    const name = names.of(a + b);
    if (name) out.push({ code: a + b, name });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** The language code meant by what was typed: a known language's name, or any well-formed code. */
export function languageFromInput(input: string, known: { code: string; name: string }[]): string | null {
  const s = input.trim();
  if (!s) return null;
  const byName = known.find((l) => l.name.toLowerCase() === s.toLowerCase());
  if (byName) return byName.code;
  try { return Intl.getCanonicalLocales(s)[0] ?? null; } catch { return null; }
}

const LANGUAGES = knownLanguages();

function NativePicker({ native, setNative }: { native: string; setNative: (n: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const code = draft === null ? null : languageFromInput(draft, LANGUAGES);
    if (code) setNative(code);
    setDraft(null);
  };
  return (
    <label className="flex items-center gap-2 text-sm">
      Cards in
      <input className="input input-sm w-44" list="transparent-input-languages" value={draft ?? languageName(native)}
             onFocus={() => setDraft('')} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); } }}
             placeholder={languageName(native)} aria-label="Language of the cards" />
      <datalist id="transparent-input-languages">
        {LANGUAGES.map((l) => <option key={l.code} value={l.name} />)}
      </datalist>
    </label>
  );
}

function Library({ native, setNative, onOpen }: { native: string; setNative: (n: string) => void; onOpen: (id: string) => void }) {
  const sources = useQuery({ gestalt: 'media-source@1', order: { field: 'title' }, limit: 200 });
  const { capabilities } = useCapabilities();
  const net = useNet();
  const write = useWrite();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [found, setFound] = useState<{ videoId: string; title: string | null; tracks: SubtitleTrack[] }>();
  const [language, setLanguage] = useViewState<string>('language', '');

  const lookUp = async () => {
    const videoId = videoIdFrom(input);
    if (!videoId) { setError("That isn't a YouTube link."); return; }
    setBusy(true); setError(undefined); setFound(undefined);
    try {
      const v = await lookUpVideo(net, videoId);
      setFound({ videoId, ...v });
      const codes = v.tracks.map((t) => t.languageCode);
      if (!codes.includes(language)) setLanguage(codes.find((c) => c.split('-')[0] !== native) ?? codes[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const add = async () => {
    if (!found) return;
    const id = await write.stableId('media-source', `youtube:${found.videoId}`);
    await write.put({ id, gestalt: 'media-source@1', provider: 'youtube', external_id: found.videoId, title: found.title ?? found.videoId, language });
    setFound(undefined); setInput('');
    onOpen(id);
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Watch with vocabulary</h2>
          <NativePicker native={native} setNative={setNative} />
        </div>
        {capabilities?.net ? (
          // no <form>: view frames don't allow form submission, and a blocked submit fails silently
          <div className="flex gap-2">
            <input className="input input-sm flex-1" placeholder="Paste a YouTube link" value={input} onChange={(e) => setInput(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && !busy && input.trim()) void lookUp(); }} aria-label="YouTube link" />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !input.trim()} onClick={() => void lookUp()}>
              {busy ? <span className="loading loading-spinner loading-xs" /> : 'Look up'}
            </button>
          </div>
        ) : capabilities && <p className="text-sm text-base-content/60">Adding videos needs the gestalter desktop app. Videos added there play here too.</p>}
        {error && <div role="alert" className="alert alert-error text-sm">{error}</div>}
        {found && (
          <div className="card card-border bg-base-100">
            <div className="card-body gap-3">
              <p className="font-semibold">{found.title ?? found.videoId}</p>
              <label className="flex items-center gap-2 text-sm">
                Subtitles
                <select className="select select-sm w-auto" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {found.tracks.map((t) => <option key={t.baseUrl} value={t.languageCode}>{t.name}{t.asr ? ' (auto)' : ''}</option>)}
                </select>
              </label>
              <button type="button" className="btn btn-sm btn-primary self-start" onClick={() => void add()}>Watch</button>
            </div>
          </div>
        )}
        <ul className="flex flex-col gap-1">
          {sources.items.map((s) => (
            <li key={s.id}>
              <button type="button" className="btn btn-ghost btn-sm h-auto w-full justify-start py-2 text-left font-normal" onClick={() => onOpen(s.id)}>
                <span className="flex-1">{String(s.value.title ?? s.value.external_id)}</span>
                <span className="text-xs text-base-content/60">{languageName(String(s.value.language))}</span>
              </button>
            </li>
          ))}
        </ul>
        {!sources.loading && !sources.items.length && <p className="text-center text-sm text-base-content/60">No videos yet.</p>}
      </div>
    </div>
  );
}

function Player({ sourceId, native, setNative, onBack }: { sourceId: string; native: string; setNative: (n: string) => void; onBack: () => void }) {
  const source = useDoc('media-source@1', sourceId);
  if (!source) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  return <Watch source={source} native={native} setNative={setNative} onBack={onBack} />;
}

type Status = { total: number | null; model: string | null; error: string | null; fatal: boolean };

/** Stored segments with those glossed since, by start. */
function merged(stored: GlossedSegment[], added: Map<number, GlossedSegment>): GlossedSegment[] {
  const all = new Map(stored.map((s) => [s.start, s]));
  for (const [start, s] of added) if (!all.has(start)) all.set(start, s);
  return [...all.values()].sort((a, b) => a.start - b.start);
}

function Watch({ source, native, setNative, onBack }: { source: Item; native: string; setNative: (n: string) => void; onBack: () => void }) {
  const videoId = String(source.value.external_id);
  const language = String(source.value.language);
  const title = String(source.value.title ?? videoId);
  const write = useWrite();
  const net = useNet();
  const llm = useLlm();
  const { capabilities } = useCapabilities();

  // --- the glossed track: what's stored, plus what this session adds
  const [trackId, setTrackId] = useState<string>();
  useEffect(() => { void write.stableId('glossed-track', `${source.id}:${language}:${native}`).then(setTrackId); }, [write, source.id, language, native]);
  const stored = useDoc('glossed-track@1', trackId ?? null);
  const storedSegments = useMemo(() => (stored?.value.segments ?? []) as GlossedSegment[], [stored]);
  // glossed in this session; the glosser reads and adds to it as it goes, the render gets a copy
  const addedRef = useRef(new Map<number, GlossedSegment>());
  const [added, setAdded] = useState(new Map<number, GlossedSegment>());
  const segments = useMemo(() => merged(storedSegments, added), [storedSegments, added]);
  const storedRef = useRef(storedSegments);
  useEffect(() => { storedRef.current = storedSegments; }, [storedSegments]);
  const [status, setStatus] = useState<Status>({ total: null, model: null, error: null, fatal: false });
  const total = status.total ?? (typeof stored?.value.segment_count === 'number' ? stored.value.segment_count : null);

  // --- the player
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  useEffect(() => {
    if (!frameRef.current) return;
    const p = new YouTubePlayer(frameRef.current);
    playerRef.current = p;
    return () => { p.destroy(); playerRef.current = null; };
  }, [videoId]);
  const src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&playsinline=1&fs=0&rel=0&origin=${encodeURIComponent(window.origin)}`;

  // --- glossing ahead of playback, where the desktop app can fetch subtitles and ask an LLM
  const save = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!trackId || !capabilities?.net) return;
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const { tracks } = await lookUpVideo(net, videoId);
      const track = tracks.find((t) => t.languageCode === language && !t.asr) ?? tracks.find((t) => t.languageCode === language);
      if (!track) throw new Error(`This video no longer has ${languageName(language)} subtitles.`);
      const metas = buildMetaSegments(await fetchCues(net, track));
      if (!live) return;
      setStatus((st) => ({ ...st, total: metas.length }));
      const done = (start: number) => addedRef.current.has(start) || storedRef.current.some((s) => s.start === start);
      if (!capabilities.llm) {
        if (metas.some((m) => !done(m.start))) setStatus((st) => ({ ...st, error: 'Set up an LLM provider in the app\'s LLM menu to gloss the rest.', fatal: true }));
        return;
      }
      const glosser = new Glosser(metas, done, async (m) => {
        const answer = await llm({ prompt: glossPrompt(m.text, language, native), json: true });
        const glosses = parseGlosses(answer.text);
        if (!glosses) throw new Error(`${answer.provider} gave an answer of the wrong shape`);
        if (!live) return [];
        addedRef.current.set(m.start, { ...m, glosses });
        setAdded(new Map(addedRef.current));
        const all = merged(storedRef.current, addedRef.current);
        setStatus((st) => ({ ...st, model: `${answer.provider} · ${answer.model}`, error: st.fatal ? st.error : null }));
        // one write at a time, each with everything so far; syncing merges by segment
        save.current = save.current.then(() => write.put({
          id: trackId, gestalt: 'glossed-track@1', source: source.id, language, native, segment_count: metas.length, model: answer.model,
          segments: all as unknown as JsonMap[],
        })).catch((e: unknown) => setStatus((st) => ({ ...st, error: `Couldn't save the glosses: ${e instanceof Error ? e.message : String(e)}` })));
        return glosses;
      }, (message, fatal) => { if (live) setStatus((st) => ({ ...st, error: message, fatal: st.fatal || fatal })); });
      timer = setInterval(() => { const p = playerRef.current; if (p) glosser.tick(p.currentTime()); }, 500);
    })().catch((e: unknown) => { if (live) setStatus((st) => ({ ...st, error: e instanceof Error ? e.message : String(e), fatal: true })); });
    return () => { live = false; clearInterval(timer); };
  }, [trackId, capabilities, net, llm, write, videoId, language, native, source.id]);

  // --- what the learner knows
  const cards = useAll(useQuery({ gestalt: 'flashcard@1', fields: ['concepts'], limit: 500 }));
  const reviews = useAll(useQuery({ gestalt: 'fsrs-data@1', limit: 500 }));
  const states = useMemo(() => fsrsStates(reviews.items), [reviews.items]);
  const cardOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cards.items) for (const concept of Object.keys((c.value.concepts ?? {}) as Record<string, number>)) m.set(concept, c.id);
    return m;
  }, [cards.items]);

  // concept ids for this track's flemmas
  const [conceptIds, setConceptIds] = useState(new Map<string, string>());
  useEffect(() => {
    const names = [...new Set(segments.flatMap((s) => s.glosses.map((g) => conceptName(language, g.flemma))))].filter((n) => !conceptIds.has(n));
    if (!names.length) return;
    void Promise.all(names.map(async (n) => [n, await conceptId(write.contentHash, n)] as const))
      .then((pairs) => setConceptIds((m) => new Map([...m, ...pairs])));
  }, [segments, language, write, conceptIds]);
  const ids = useMemo(() => [...new Set(conceptIds.values())].slice(0, 500), [conceptIds]);
  const existing = useQuery(ids.length ? { gestalt: 'concept@2', ids, fields: [], limit: 500 } : null);
  const exists = useMemo(() => new Set(existing.items.map((c) => c.id)), [existing.items]);

  const conceptOf = useCallback((g: Gloss) => conceptIds.get(conceptName(language, g.flemma)), [conceptIds, language]);
  const standingOf = useCallback((g: Gloss) => standing(conceptOf(g), cardOf, states, new Date()), [conceptOf, cardOf, states]);

  // what the timer and the recording read: the newest of each
  const latest = useRef({ segments, standingOf, conceptOf, exists });
  useEffect(() => { latest.current = { segments, standingOf, conceptOf, exists }; }, [segments, standingOf, conceptOf, exists]);

  // --- recording what was shown: the flemma's concept (made the first time), the video's link to it, an exposure
  const created = useRef(new Set<string>());
  const pendingLinks = useRef(new Set<string>());
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);
  const recordFailed = useCallback((e: unknown) => setStatus((st) => ({ ...st, error: `Couldn't record a word: ${e instanceof Error ? e.message : String(e)}` })), []);

  const record = useCallback(async (g: Gloss) => {
    const name = conceptName(language, g.flemma);
    const concept = latest.current.conceptOf(g) ?? await conceptId(write.contentHash, name);
    if (!latest.current.exists.has(concept) && !created.current.has(concept)) {
      created.current.add(concept);
      await write.put({ id: concept, gestalt: 'concept@2', name });
    }
    await write.put(practiceEvent(concept, 'transparent-input', 0, new Date(), source.id));
    pendingLinks.current.add(concept);
  }, [write, language, source.id]);

  // the video's links are written together every few seconds, not once per card
  const flushLinks = useCallback(() => {
    const value = withConcepts(sourceRef.current.value, [...pendingLinks.current]);
    pendingLinks.current.clear();
    if (value) write.put(value).catch(recordFailed);
  }, [write, recordFailed]);
  useEffect(() => {
    const timer = setInterval(flushLinks, 5000);
    return () => { clearInterval(timer); flushLinks(); };
  }, [flushLinks]);

  // --- cards over the video
  const [shown, setShown] = useState<ShownCard[]>([]);
  const shownRef = useRef<ShownCard[]>([]);
  const timing = useRef({ segment: -1, nextAt: null as number | null, pausedAt: null as number | null, key: 0 });

  useEffect(() => {
    const t = timing.current;
    const show = (cards: ShownCard[]) => { shownRef.current = cards; setShown(cards); };
    const tick = () => {
      const p = playerRef.current;
      if (!p) return;
      const now = performance.now();
      if (!p.playing()) { t.pausedAt ??= now; return; }
      let cards = shownRef.current;
      if (t.pausedAt !== null) {
        const paused = now - t.pausedAt;
        t.pausedAt = null;
        if (t.nextAt !== null) t.nextAt += paused;
        cards = cards.map((c) => ({ ...c, expireAt: c.expireAt + paused }));
      }
      cards = cards.filter((c) => c.expireAt > now);
      const { segments: segs, standingOf: st } = latest.current;
      const i = segmentAt(segs, p.currentTime());
      if (i !== t.segment) {
        t.segment = i;
        t.nextAt = i === -1 ? null : now + (MIN_GAP_S + Math.random() * (MAX_GAP_S - MIN_GAP_S)) * 1000;
      }
      if (i !== -1 && t.nextAt !== null && now >= t.nextAt) {
        t.nextAt = now + (MIN_GAP_S + Math.random() * (MAX_GAP_S - MIN_GAP_S)) * 1000;
        const g = pickGloss(segs[i].glosses, new Set(cards.map((c) => c.gloss.surface)), st);
        if (g) {
          cards = [...(cards.length >= MAX_CARDS ? cards.slice(1) : cards), { key: ++t.key, gloss: g, standing: st(g), expireAt: now + CARD_MS }];
          record(g).catch(recordFailed);
        }
      }
      if (cards !== shownRef.current) show(cards);
    };
    const timer = setInterval(tick, 300);
    return () => clearInterval(timer);
  }, [record, recordFailed]);

  const fullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen(); else void el.requestFullscreen().catch(() => {});
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mx-auto flex max-w-4xl flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="All videos" aria-label="All videos" onClick={onBack}><ArrowLeft className="size-4" /></button>
          <h2 className="min-w-0 flex-1 truncate font-semibold" title={title}>{title}</h2>
          <span className="text-sm text-base-content/60">{languageName(language)}</span>
          <NativePicker native={native} setNative={setNative} />
        </div>
        <div ref={wrapRef} className="relative aspect-video w-full overflow-hidden rounded-box bg-black">
          <iframe ref={frameRef} className="absolute inset-0 h-full w-full" src={src} title={title}
                  referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture" />
          <div className="pointer-events-none absolute top-2 left-2 flex max-w-[70%] flex-col items-start gap-1.5">
            {shown.map((c) => <WordCard key={c.key} card={c} />)}
          </div>
          <button type="button" className="btn btn-xs btn-square absolute right-2 bottom-12 border-0 bg-black/60 text-white hover:bg-black/80" title="Fullscreen, with cards" aria-label="Fullscreen" onClick={fullscreen}>
            <Expand className="size-3" />
          </button>
        </div>
        <StatusLine glossed={segments.length} total={total} status={status} />
      </div>
    </div>
  );
}

/** A word and its translation, over the video; it takes no clicks, so the player keeps them. */
function WordCard({ card: c }: { card: ShownCard }) {
  return (
    <div className={`rounded-full bg-black/85 px-3 py-1 text-sm text-white backdrop-blur ${c.standing === 'due' ? 'ring-2 ring-warning' : ''}`}>
      <span className="font-semibold">{c.gloss.surface}</span> = {c.gloss.translation}
    </div>
  );
}

function StatusLine({ glossed, total, status: s }: { glossed: number; total: number | null; status: Status }) {
  const progress = total ? `${glossed} of ${total} segments glossed` : glossed ? `${glossed} segments glossed` : 'Nothing glossed yet';
  return (
    <p className="text-xs text-base-content/60">
      {progress}{s.model && ` · ${s.model}`}
      {s.error && <span className={s.fatal ? 'text-error' : 'text-warning'}> · {s.error}</span>}
    </p>
  );
}

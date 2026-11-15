import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleHelp, Minus, Plus, RotateCcw } from 'lucide-react';
import { Credits, usePanZoom, type PanZoomTransform } from '@gestalts/kit';
import { fsrsStates, getScheduler, logPractice, Rating, review, saveReview, useLocalReviews, usePracticeSession, type Facet, type FsrsStates, type ReviewState, type Scheduler } from '@gestalts/learning';
import { useBlobUrl, useQuery, useWrite, type Item, type JsonMap, type QueryResult } from '@gestalts/view';

/**
 * Where the countries of the world are, on a map. Five kinds of exercise, each a `map-exercise@1` made by an
 * `item-model@1` of that name: find a country in its neighborhood (a close-up, moved to one of 9 places on screen) or
 * on the world map, by clicking it ("I have no idea" shows it, and you click it then); name the circled country of the
 * world, or the highlighted one of a close-up, out of two; and name each country of a group (Balkans, …), one after
 * another. Only the first try counts: right is Good, anything else Again, for the country's spaced-repetition card
 * (`fsrs-data` on its concept) and the exercise's (on the exercise, per place on screen for the neighborhood one), and
 * a practice event on the exercise (+1, −1, −2 for giving up).
 *
 * What comes next: a group with half its countries due or unseen, not shown today, one time in five; else a country,
 * due ones first, then unseen ones, never the one before, leaning towards priority 1 (50%), 2 (30%), 3 (20%); a country
 * never practised starts with "which country is highlighted?"; else one of its exercises, due first, then unseen.
 *
 * The map's geometry comes already projected (Mercator) from its `map@1`'s blob, so every view of it is the same paths
 * under an affine transform: k = 1 is always the whole world, and each exercise's starting view a pan/zoom over it.
 */

const VIEW = 'world-map';
const SUCCESS_DELAY_MS = 600;

// ---------- the look (the old app's mapStyle.ts) ----------

const WATER_COLOR = '#dcefff';
const COUNTRY_FILL_COLOR = '#e6e6e6';
const MAP_STROKE_COLOR = '#787878';
const MAP_STROKE_WIDTH = 2;
const MARKER_STROKE_WIDTH = 2;
// the marker circle shows only while its country is too small on screen to make out; two thresholds, so zooming around
// the boundary doesn't flicker it
const MARKER_VISIBILITY_SHOW_BELOW_PX = 50;
const MARKER_VISIBILITY_HIDE_ABOVE_PX = 70;
// k = 1 is the world view, the floor; the ceiling is this or enough above the exercise's own start to zoom in further
const ZOOM_SCALE_EXTENT: [number, number] = [1, 8];
const ZOOM_MAX_HEADROOM = 3;
const ZOOM_CLICK_DISTANCE = 6;
const ZOOM_BUTTON_FACTOR = 1.5;
const ZOOM_TRANSITION_MS = 250;
const HIGHLIGHT_COLOR = '#3b82f6';
const SUCCESS_COLOR = '#22c55e';

// ---------- geometry and projection (the old app's mapProjection.ts) ----------

/** raw Mercator units of the deck's builder: `[x0, y0, x1, y1]` boxes, `[x, y]` points */
type Region = { name: string; d: string; centroid: [number, number]; bounds: [number, number, number, number]; size: number };
type Geometry = { bounds: [number, number, number, number]; regions: Record<string, Region> };
/** raw point `p` shows at `s·p + (tx, ty)`; Mercator without rotation is affine, so this is every view of it */
type Affine = { s: number; tx: number; ty: number };

const PAN_GRID_SIZE = 3;
const PAN_INDEX_COUNT = PAN_GRID_SIZE * PAN_GRID_SIZE;
const ZOOM_MIN = 100;
const ZOOM_RANGE = 75;
const ZOOM_COUNTRY_WEIGHT = 0.6;
const MARKER_TARGET_RADIUS_PX = 15;
const MARKER_MIN_FRACTION = 0.03;
const MARKER_MAX_FRACTION = 0.14;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const zoomProgress = (zoom: number | undefined) => (zoom ? clamp01((zoom - ZOOM_MIN) / ZOOM_RANGE) : 0);

function interpolateScale(worldScale: number, countryScale: number, progress: number): number {
  const maxZoomScale = worldScale + (countryScale - worldScale) * ZOOM_COUNTRY_WEIGHT;
  return worldScale + (maxZoomScale - worldScale) * progress;
}

function panIndexToTranslate(panIndex: number, width: number, height: number): [number, number] {
  const cellWidth = width / PAN_GRID_SIZE;
  const cellHeight = height / PAN_GRID_SIZE;
  return [(panIndex % PAN_GRID_SIZE) * cellWidth + cellWidth / 2, Math.floor(panIndex / PAN_GRID_SIZE) * cellHeight + cellHeight / 2];
}

function computeMarkerRadius(width: number, height: number): number {
  const base = Math.min(width, height);
  return Math.min(Math.max(MARKER_TARGET_RADIUS_PX, base * MARKER_MIN_FRACTION), base * MARKER_MAX_FRACTION);
}

/** d3's `fitSize`: the box fills `width` × `height` as far as it can, centred */
function fit([x0, y0, x1, y1]: Region['bounds'], width: number, height: number): Affine {
  const s = Math.min(width / (x1 - x0), height / (y1 - y0));
  return { s, tx: (width - s * (x1 + x0)) / 2, ty: (height - s * (y1 + y0)) / 2 };
}

function union(boxes: Region['bounds'][]): Region['bounds'] {
  return boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
}

const countryName = (geo: Geometry, code: string) => geo.regions[code]?.name ?? code;

/** the world zoomed towards `target` by `zoom`, its centroid at pan cell `panIndex`; the world without a target */
function computeMapProjection(geo: Geometry, world: Affine, width: number, height: number, target?: string, zoom?: number, panIndex?: number): Affine {
  const region = target ? geo.regions[target] : undefined;
  if (!region) return world;
  const progress = zoomProgress(zoom);
  if (progress <= 0) return world;
  const s = interpolateScale(world.s, fit(region.bounds, width, height).s, progress);
  const [px, py] = panIndexToTranslate(panIndex ?? 4, width, height);
  return { s, tx: px - s * region.centroid[0], ty: py - s * region.centroid[1] };
}

function computeGroupProjection(geo: Geometry, world: Affine, width: number, height: number, countries: string[]): Affine {
  const boxes = countries.flatMap((c) => (geo.regions[c] ? [geo.regions[c].bounds] : []));
  return boxes.length ? fit(union(boxes), width, height) : world;
}

/** the pan/zoom over the world view that shows `target` */
function toZoomTransform(world: Affine, target: Affine): PanZoomTransform {
  const k = target.s / world.s;
  return { k, x: target.tx - k * world.tx, y: target.ty - k * world.ty };
}

const IDENTITY: PanZoomTransform = { k: 1, x: 0, y: 0 };

// ---------- the map ----------

type CanvasProps = {
  geo: Geometry;
  targetCountry?: string;
  zoom?: number;
  panIndex?: number;
  groupCountries?: string[];
  highlightCountry?: string;
  highlightColor?: string;
  markerCountry?: string;
  onCountryClicked?: (code: string) => void;
};
type CanvasHandle = { revealCountry(code: string): void };

// buttons only for fine pointers (mouse, trackpad); touch pinches and drags
const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

const HOVER_CSS = `@media (hover: hover) and (pointer: fine) {
  .world-map-country { transition: filter 0.1s ease; }
  .world-map-country:hover { filter: brightness(0.9); }
}`;

const WorldMapCanvas = forwardRef<CanvasHandle, CanvasProps>(function WorldMapCanvas(props, handle) {
  const { geo, targetCountry, zoom, panIndex, groupCountries, highlightCountry, highlightColor, markerCountry, onCountryClicked } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const markerRef = useRef<SVGCircleElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // the one pan/zoom, mirrored for the buttons; every change comes through d3-zoom and `onZoom`
  const [transform, setTransform] = useState<PanZoomTransform>(IDENTITY);
  const current = useRef<PanZoomTransform>(IDENTITY);
  const marker = useRef({ baseMaxDim: 0, targetRadius: 0, hiddenBySize: false });

  const updateMarkerOnZoom = useCallback(() => {
    const circle = markerRef.current;
    if (!circle) return;
    const { k } = current.current;
    const m = marker.current;
    circle.setAttribute('r', String(m.targetRadius / k));
    const onScreenMaxDim = m.baseMaxDim * k;
    if (m.hiddenBySize && onScreenMaxDim < MARKER_VISIBILITY_SHOW_BELOW_PX) m.hiddenBySize = false;
    else if (!m.hiddenBySize && onScreenMaxDim > MARKER_VISIBILITY_HIDE_ABOVE_PX) m.hiddenBySize = true;
    circle.style.display = m.hiddenBySize ? 'none' : '';
  }, []);

  const onZoom = useCallback((t: PanZoomTransform) => {
    current.current = t;
    groupRef.current?.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    updateMarkerOnZoom();
    setTransform(t);
  }, [updateMarkerOnZoom]);
  const panZoom = usePanZoom(onZoom, { clickDistance: ZOOM_CLICK_DISTANCE });
  const { attach } = panZoom;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth && el.clientHeight) setSize((s) => (s && s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const world = useMemo(() => (size ? fit(geo.bounds, size.width, size.height) : null), [geo, size]);
  const groupKey = groupCountries?.join(',') ?? '';

  // the exercise's own starting view, as a pan/zoom over the world view, and how far in it may go from there
  const initial = useMemo(() => {
    if (!world || !size) return null;
    const target = groupKey
      ? computeGroupProjection(geo, world, size.width, size.height, groupKey.split(','))
      : computeMapProjection(geo, world, size.width, size.height, targetCountry, zoom, panIndex);
    // fitting a few very large countries alone needs less than the world's scale; start at the world then
    const candidate = toZoomTransform(world, target);
    const transform = candidate.k < 1 ? IDENTITY : candidate;
    return { transform, maxScale: Math.max(ZOOM_SCALE_EXTENT[1], transform.k * ZOOM_MAX_HEADROOM) };
  }, [geo, world, size, targetCountry, zoom, panIndex, groupKey]);

  // a new target, zoom, place or group is a new view: snap to it; a resize only moves the bounds
  const viewKey = `${targetCountry}|${zoom}|${panIndex}|${groupKey}`;
  const shownView = useRef<string | null>(null);
  useEffect(() => {
    if (!initial || !size) return;
    panZoom.setExtent([ZOOM_SCALE_EXTENT[0], initial.maxScale], [[0, 0], [size.width, size.height]]);
    if (shownView.current !== viewKey) {
      shownView.current = viewKey;
      panZoom.transformTo(initial.transform);
    }
  }, [initial, size, viewKey, panZoom]);

  const markerAt = useMemo(() => {
    const region = markerCountry ? geo.regions[markerCountry] : undefined;
    if (!region || !world || !size) return null;
    return { cx: world.s * region.centroid[0] + world.tx, cy: world.s * region.centroid[1] + world.ty, baseMaxDim: region.size * world.s, targetRadius: computeMarkerRadius(size.width, size.height) };
  }, [geo, markerCountry, world, size]);
  useEffect(() => {
    marker.current = { baseMaxDim: markerAt?.baseMaxDim ?? 0, targetRadius: markerAt?.targetRadius ?? 0, hiddenBySize: false };
    updateMarkerOnZoom();
  }, [markerAt, updateMarkerOnZoom]);

  useImperativeHandle(handle, () => ({
    // a close-up of the country, centred on its centroid, no further in than the app's normal maximum: fitting a small
    // country tight would go past what its simplified coastline can show cleanly
    revealCountry(code: string) {
      const region = geo.regions[code];
      if (!region || !world || !size) return;
      const countryScale = fit(region.bounds, size.width, size.height).s;
      const k = Math.min(Math.max(interpolateScale(world.s, countryScale, 1) / world.s, ZOOM_SCALE_EXTENT[0]), ZOOM_SCALE_EXTENT[1]);
      const [wx, wy] = [world.s * region.centroid[0] + world.tx, world.s * region.centroid[1] + world.ty];
      panZoom.transformTo({ k, x: size.width / 2 - k * wx, y: size.height / 2 - k * wy }, ZOOM_TRANSITION_MS);
    },
  }), [geo, world, size, panZoom]);

  // drawn once per geometry and size; fills change with the highlight, never with the pan/zoom
  const paths = useMemo(() => Object.entries(geo.regions).map(([code, r]) => (
    <path key={code} data-country={code} className="world-map-country" d={r.d} stroke={MAP_STROKE_COLOR} strokeWidth={MAP_STROKE_WIDTH} vectorEffect="non-scaling-stroke"
      fill={code === highlightCountry ? (highlightColor ?? HIGHLIGHT_COLOR) : COUNTRY_FILL_COLOR} style={{ cursor: 'pointer' }} />
  )), [geo, highlightCountry, highlightColor]);

  const maxScale = initial?.maxScale ?? ZOOM_SCALE_EXTENT[1];
  const canZoomIn = transform.k < maxScale - 0.01;
  const canZoomOut = transform.k > ZOOM_SCALE_EXTENT[0] + 0.01;
  const start = initial?.transform ?? IDENTITY;
  const isAtInitialView = Math.abs(transform.k - start.k) < 0.01 && Math.abs(transform.x - start.x) < 0.5 && Math.abs(transform.y - start.y) < 0.5;
  const button = 'btn btn-circle pointer-events-auto bg-base-100/90 text-base-content shadow-sm backdrop-blur';

  return (
    <div ref={containerRef} className="relative h-full w-full touch-none overscroll-contain">
      <style>{HOVER_CSS}</style>
      <svg ref={attach} width={size?.width ?? 0} height={size?.height ?? 0} className="block">
        <rect width={size?.width ?? 0} height={size?.height ?? 0} fill={WATER_COLOR} />
        <g ref={groupRef}>
          {world && (
            <g transform={`matrix(${world.s},0,0,${world.s},${world.tx},${world.ty})`}
              onClick={(e) => { const code = (e.target as Element).getAttribute('data-country'); if (code) onCountryClicked?.(code); }}>
              {paths}
            </g>
          )}
          {markerAt && (
            <circle ref={markerRef} cx={markerAt.cx} cy={markerAt.cy} r={markerAt.targetRadius} fill="none" stroke={HIGHLIGHT_COLOR}
              strokeWidth={MARKER_STROKE_WIDTH} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />
          )}
        </g>
      </svg>
      <div className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 flex-col gap-2">
        {!isTouchDevice && (
          <>
            <button type="button" className={button} disabled={!canZoomIn} aria-label="Zoom in" onClick={() => panZoom.scaleBy(ZOOM_BUTTON_FACTOR, ZOOM_TRANSITION_MS)}><Plus size={20} aria-hidden="true" /></button>
            <button type="button" className={button} disabled={!canZoomOut} aria-label="Zoom out" onClick={() => panZoom.scaleBy(1 / ZOOM_BUTTON_FACTOR, ZOOM_TRANSITION_MS)}><Minus size={20} aria-hidden="true" /></button>
          </>
        )}
        <button type="button" className={button} disabled={isAtInitialView} aria-label="Reset view" onClick={() => panZoom.transformTo(start, ZOOM_TRANSITION_MS)}><RotateCcw size={20} aria-hidden="true" /></button>
      </div>
    </div>
  );
});

// ---------- the exercises ----------

type Kind = 'find-in-neighborhood' | 'find-on-world-map' | 'identify-country' | 'distractor-choice' | 'group-sequence';

type Next =
  | { type: 'find-in-neighborhood'; exercise: string; country: string; zoom: number; panIndex: number }
  | { type: 'find-on-world-map'; exercise: string; country: string }
  | { type: 'identify-country'; exercise: string; country: string; distractor: string }
  | { type: 'distractor-choice'; exercise: string; country: string; zoom: number; panIndex: number; distractor: string }
  | { type: 'group-sequence'; groupId: string; countries: string[]; exercises: Record<string, string> };

/** one answer, as the old app's `SubmittedAnswer` */
type Answer = { type: Kind; exercise: string; country: string; panIndex?: number; distractor?: string; numberOfClicksNeeded: number; msToFirstClick: number; gaveUp?: boolean };

const pickRandom = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const ordered = <T,>(a: T, b: T): [T, T] => (Math.random() < 0.5 ? [a, b] : [b, a]);

function Instruction({ correct, children }: { correct: boolean; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-3 pt-3 sm:pt-6">
      <div className={`card card-border pointer-events-auto bg-base-100/90 p-3 text-center shadow-sm backdrop-blur ${correct ? 'bg-success/10' : ''}`}>{children}</div>
    </div>
  );
}

function BottomBar({ children }: { children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:p-6 sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]">{children}</div>;
}

/** Click the country on the map; "I have no idea" shows it, and you click it then. */
function FindExercise({ geo, next, onShown, onSubmitted }: { geo: Geometry; next: Extract<Next, { type: 'find-in-neighborhood' | 'find-on-world-map' }>; onShown: () => void; onSubmitted: (a: Answer) => void }) {
  const mapRef = useRef<CanvasHandle>(null);
  const [highlight, setHighlight] = useState<{ country?: string; color?: string }>({});
  const [isCorrect, setIsCorrect] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const attempts = useRef(0);
  const startTime = useRef(0);
  const firstClickMs = useRef<number | null>(null);
  useEffect(() => { startTime.current = performance.now(); onShown(); }, [onShown]);
  const neighborhood = next.type === 'find-in-neighborhood';

  const handleClick = (clicked: string) => {
    if (isCorrect) return;
    attempts.current += 1;
    firstClickMs.current ??= performance.now() - startTime.current;
    if (clicked === next.country) {
      setIsCorrect(true);
      setHighlight({ country: next.country, color: SUCCESS_COLOR });
      setTimeout(() => onSubmitted({
        type: next.type, exercise: next.exercise, country: next.country, ...(neighborhood ? { panIndex: next.panIndex } : {}),
        numberOfClicksNeeded: attempts.current, msToFirstClick: firstClickMs.current ?? 0, gaveUp,
      }), SUCCESS_DELAY_MS);
      return;
    }
    setHighlight({ country: next.country });
  };

  const handleGiveUp = () => {
    if (isCorrect || gaveUp) return;
    setGaveUp(true);
    attempts.current += 1;
    firstClickMs.current ??= performance.now() - startTime.current;
    setHighlight({ country: next.country });
    mapRef.current?.revealCountry(next.country);
  };

  const name = countryName(geo, next.country);
  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <WorldMapCanvas ref={mapRef} geo={geo} targetCountry={next.country} zoom={neighborhood ? next.zoom : undefined} panIndex={neighborhood ? next.panIndex : undefined}
          highlightCountry={highlight.country} highlightColor={highlight.color} onCountryClicked={handleClick} />
      </div>
      <Instruction correct={isCorrect}>
        <p className="text-sm font-medium">{neighborhood ? `Find ${name} in its neighborhood` : `Find ${name} on the world map`}</p>
      </Instruction>
      {!isCorrect && !gaveUp && (
        <BottomBar>
          <button type="button" className="btn btn-outline pointer-events-auto bg-base-100/90 shadow-sm backdrop-blur" onClick={handleGiveUp}>
            <CircleHelp size={18} aria-hidden="true" /> I have no idea
          </button>
        </BottomBar>
      )}
    </div>
  );
}

/** Two names, one right; a wrong pick turns red and stays, and you pick the other. */
function ChoiceButtons({ geo, options, selected, isCorrect, onSelect }: { geo: Geometry; options: string[]; selected?: string; isCorrect: boolean; onSelect: (o: string) => void }) {
  return (
    <BottomBar>
      <div className="pointer-events-auto grid grid-cols-2 gap-3">
        {options.map((option) => (
          <button key={option} type="button" onClick={() => onSelect(option)}
            className={`btn shadow-sm backdrop-blur ${option === selected ? (isCorrect ? 'btn-success' : 'btn-error') : 'btn-outline bg-base-100/90'} ${isCorrect || option === selected ? 'pointer-events-none' : ''}`}>
            {countryName(geo, option)}
          </button>
        ))}
      </div>
    </BottomBar>
  );
}

/** Which country is this (circled, on the world), or which is highlighted (close up)? */
function ChoiceExercise({ geo, next, onShown, onSubmitted }: { geo: Geometry; next: Extract<Next, { type: 'identify-country' | 'distractor-choice' }>; onShown: () => void; onSubmitted: (a: Answer) => void }) {
  const [options] = useState(() => ordered(next.country, next.distractor));
  const [selected, setSelected] = useState<string>();
  const [isCorrect, setIsCorrect] = useState(false);
  const attempts = useRef(0);
  const startTime = useRef(0);
  const firstClickMs = useRef<number | null>(null);
  useEffect(() => { startTime.current = performance.now(); onShown(); }, [onShown]);
  const identify = next.type === 'identify-country';

  const handleSelect = (option: string) => {
    if (isCorrect) return;
    attempts.current += 1;
    firstClickMs.current ??= performance.now() - startTime.current;
    setSelected(option);
    if (option !== next.country) return;
    setIsCorrect(true);
    setTimeout(() => onSubmitted({
      type: next.type, exercise: next.exercise, country: next.country, distractor: next.distractor, ...(identify ? {} : { panIndex: next.panIndex }),
      numberOfClicksNeeded: attempts.current, msToFirstClick: firstClickMs.current ?? 0,
    }), SUCCESS_DELAY_MS);
  };

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        {identify
          ? <WorldMapCanvas geo={geo} highlightCountry={next.country} markerCountry={next.country} />
          : <WorldMapCanvas geo={geo} targetCountry={next.country} zoom={next.zoom} panIndex={next.panIndex} highlightCountry={next.country} />}
      </div>
      <Instruction correct={isCorrect}>
        <p className="text-sm font-medium">{identify ? 'Which country is this?' : 'Which country is highlighted?'}</p>
      </Instruction>
      <ChoiceButtons geo={geo} options={options} selected={selected} isCorrect={isCorrect} onSelect={handleSelect} />
    </div>
  );
}

/** Each country of a group in turn, on a map fitted to the group, out of two of its countries. Each step is an answer. */
function GroupSequenceExercise({ geo, next, onShown, onStep, onSubmitted }: { geo: Geometry; next: Extract<Next, { type: 'group-sequence' }>; onShown: () => void; onStep: (a: Answer) => void; onSubmitted: (a: Answer) => void }) {
  const pickDistractor = (country: string) => pickRandom(next.countries.filter((c) => c !== country));
  const [stepIndex, setStepIndex] = useState(0);
  const [options, setOptions] = useState(() => ordered(next.countries[0], pickDistractor(next.countries[0])));
  const [selected, setSelected] = useState<string>();
  const [isCorrect, setIsCorrect] = useState(false);
  const attempts = useRef(0);
  const startTime = useRef(0);
  const firstClickMs = useRef<number | null>(null);
  const currentCountry = next.countries[stepIndex];
  const isLastStep = stepIndex === next.countries.length - 1;
  useEffect(() => { startTime.current = performance.now(); onShown(); }, [onShown, stepIndex]);

  const handleSelect = (option: string) => {
    if (isCorrect) return;
    attempts.current += 1;
    firstClickMs.current ??= performance.now() - startTime.current;
    setSelected(option);
    if (option !== currentCountry) return;
    setIsCorrect(true);
    const answer: Answer = {
      type: 'group-sequence', exercise: next.exercises[currentCountry], country: currentCountry, distractor: options.find((o) => o !== currentCountry),
      numberOfClicksNeeded: attempts.current, msToFirstClick: firstClickMs.current ?? 0,
    };
    setTimeout(() => {
      if (isLastStep) { onSubmitted(answer); return; }
      onStep(answer);
      const following = next.countries[stepIndex + 1];
      attempts.current = 0;
      firstClickMs.current = null;
      setSelected(undefined);
      setIsCorrect(false);
      setOptions(ordered(following, pickDistractor(following)));
      setStepIndex(stepIndex + 1);
    }, SUCCESS_DELAY_MS);
  };

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <WorldMapCanvas geo={geo} groupCountries={next.countries} highlightCountry={currentCountry} markerCountry={currentCountry} />
      </div>
      <Instruction correct={isCorrect}>
        <p className="text-sm font-medium">Which country is this?</p>
        <p className="text-xs text-base-content/60">{stepIndex + 1} / {next.countries.length}</p>
      </Instruction>
      <ChoiceButtons geo={geo} options={options} selected={selected} isCorrect={isCorrect} onSelect={handleSelect} />
    </div>
  );
}

// ---------- what comes next (the old app's progressScheduler.ts) ----------

const GROUP_TRIGGER_FRACTION = 0.5;
// a qualifying group competes at equal odds with the other four kinds, rather than always going first
const GROUP_EXERCISE_ODDS = 1 / 5;
const PRIORITY_1_ODDS = 0.5;
const PRIORITY_2_ODDS = 0.8;
const DEFAULT_PRIORITY = 2;
const DEFAULT_NEIGHBORHOOD_ZOOM = 100;
const DEFAULT_DISTRACTOR_ZOOM = 140;

type Exercise = { id: string; kind: Kind; country: string; zoom?: number; distractors: string[]; priority: number; group?: string };
type Candidate = { country: string; concept: string; priority: number; byKind: Partial<Record<Kind, Exercise>> };
type Group = { id: string; countries: string[]; exercises: Record<string, string> };
type Deck = { candidates: Candidate[]; concepts: Map<string, string>; groups: Group[]; identifyPool: string[] };

/** the country's card: on its concept */
const countryFacet = (concept: string): Facet => ({ target: concept });
/** an exercise's card: on the exercise, and for the neighborhood one per place on screen */
const exerciseFacet = (exercise: string, panIndex?: number): Facet => ({ target: exercise, ...(panIndex === undefined ? {} : { facet: `pan-${panIndex}` }) });

const isDue = (s: ReviewState, now: Date) => new Date(s.card.dueAt) <= now;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function pickPreferredPriority(): number {
  const roll = Math.random();
  if (roll < PRIORITY_1_ODDS) return 1;
  if (roll < PRIORITY_2_ODDS) return 2;
  return 3;
}

/** due ones, else unseen ones, else all */
function duePool<T>(items: T[], stateOf: (t: T) => ReviewState | undefined, now: Date): T[] {
  const due: T[] = [];
  const fresh: T[] = [];
  for (const item of items) {
    const s = stateOf(item);
    if (!s) fresh.push(item);
    else if (isDue(s, now)) due.push(item);
  }
  return due.length ? due : fresh.length ? fresh : items;
}

function findQualifyingGroup(deck: Deck, states: FsrsStates, now: Date): Group | undefined {
  const today = dayKey(now);
  const qualifying = deck.groups.filter((group) => {
    const shownToday = Object.values(group.exercises).some((id) => {
      const at = states.get(exerciseFacet(id))?.card.lastReviewAt;
      return typeof at === 'string' && dayKey(new Date(at)) === today;
    });
    if (shownToday) return false;
    const dueOrUnseen = group.countries.filter((code) => {
      const concept = deck.concepts.get(code);
      const s = concept ? states.get(countryFacet(concept)) : undefined;
      return !s || isDue(s, now);
    }).length;
    return dueOrUnseen / group.countries.length >= GROUP_TRIGGER_FRACTION;
  });
  return qualifying.length ? pickRandom(qualifying) : undefined;
}

function distractorChoice(c: Candidate): Next {
  const e = c.byKind['distractor-choice']!;
  return { type: 'distractor-choice', exercise: e.id, country: c.country, zoom: e.zoom ?? DEFAULT_DISTRACTOR_ZOOM, panIndex: Math.floor(Math.random() * PAN_INDEX_COUNT), distractor: pickRandom(e.distractors) };
}

type Instance = { kind: Exclude<Kind, 'group-sequence'>; exercise: Exercise; panIndex?: number };

function loadNextExercise(deck: Deck, states: FsrsStates, lastCountry: string | null, now: Date): { next: Next; country: string } | null {
  const group = findQualifyingGroup(deck, states, now);
  if (group && Math.random() < GROUP_EXERCISE_ODDS) {
    const countries = Math.random() < 0.5 ? group.countries : [...group.countries].reverse();
    return { next: { type: 'group-sequence', groupId: group.id, countries, exercises: group.exercises }, country: countries[countries.length - 1] };
  }

  if (!deck.candidates.length) return null;
  const candidates = deck.candidates.length > 1 ? deck.candidates.filter((c) => c.country !== lastCountry) : deck.candidates;
  const pool = duePool(candidates, (c) => states.get(countryFacet(c.concept)), now);
  const preferredPriority = pickPreferredPriority();
  const preferred = pool.filter((c) => c.priority === preferredPriority);
  const picked = pickRandom(preferred.length ? preferred : pool);

  // a country never practised is introduced with the highlighted close-up and its curated distractors
  if (!states.has(countryFacet(picked.concept)) && picked.byKind['distractor-choice']) return { next: distractorChoice(picked), country: picked.country };

  const instances: Instance[] = [];
  const n = picked.byKind['find-in-neighborhood'];
  if (n) for (let panIndex = 0; panIndex < PAN_INDEX_COUNT; panIndex++) instances.push({ kind: 'find-in-neighborhood', exercise: n, panIndex });
  const w = picked.byKind['find-on-world-map'];
  if (w) instances.push({ kind: 'find-on-world-map', exercise: w });
  const i = picked.byKind['identify-country'];
  if (i && deck.identifyPool.length > 1) instances.push({ kind: 'identify-country', exercise: i });
  const d = picked.byKind['distractor-choice'];
  if (d) instances.push({ kind: 'distractor-choice', exercise: d });
  if (!instances.length) return null;

  const instance = pickRandom(duePool(instances, (x) => states.get(exerciseFacet(x.exercise.id, x.panIndex)), now));
  const country = picked.country;
  switch (instance.kind) {
    case 'find-in-neighborhood':
      return { next: { type: 'find-in-neighborhood', exercise: instance.exercise.id, country, zoom: instance.exercise.zoom ?? DEFAULT_NEIGHBORHOOD_ZOOM, panIndex: instance.panIndex! }, country };
    case 'identify-country':
      return { next: { type: 'identify-country', exercise: instance.exercise.id, country, distractor: pickRandom(deck.identifyPool.filter((c) => c !== country)) }, country };
    case 'distractor-choice':
      return { next: distractorChoice(picked), country };
    default:
      return { next: { type: 'find-on-world-map', exercise: instance.exercise.id, country }, country };
  }
}

// ---------- the view ----------

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every page of a query: what comes next is picked from all of them. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}
const ready = (...rs: QueryResult[]) => rs.every((r) => !r.loading && !r.hasMore);

function buildDeck(exerciseItems: Item[], modelItems: Item[], groupItems: Item[]): Deck {
  const kindOf = new Map(modelItems.map((m) => [m.id, str(m.value.name) as Kind]));
  const exercises: Exercise[] = exerciseItems.flatMap((item) => {
    const kind = kindOf.get(str(item.value.model));
    if (!kind) return [];
    const v = item.value;
    return [{
      id: item.id, kind, country: str(v.country), zoom: typeof v.zoom === 'number' ? v.zoom : undefined,
      distractors: Array.isArray(v.distractors) ? v.distractors.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof v.priority === 'number' ? v.priority : DEFAULT_PRIORITY, ...(str(v.group) ? { group: str(v.group) } : {}),
    }];
  });
  const concepts = new Map<string, string>();
  for (const item of exerciseItems) {
    const c = item.value.concepts;
    const first = c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c)[0] : undefined;
    if (first) concepts.set(str(item.value.country), first);
  }
  const byCountry = new Map<string, Candidate>();
  for (const e of exercises) {
    if (e.kind === 'group-sequence') continue;
    if (e.kind === 'distractor-choice' && !e.distractors.length) continue;
    const concept = concepts.get(e.country);
    if (!concept) continue;
    const c = byCountry.get(e.country) ?? { country: e.country, concept, priority: e.priority, byKind: {} };
    c.byKind[e.kind] = e;
    byCountry.set(e.country, c);
  }
  const groups: Group[] = groupItems.flatMap((g) => {
    const countries = Array.isArray(g.value.countries) ? g.value.countries.filter((c): c is string => typeof c === 'string') : [];
    const steps = exercises.filter((e) => e.kind === 'group-sequence' && e.group === g.id);
    const ids = Object.fromEntries(steps.map((e) => [e.country, e.id]));
    const present = countries.filter((c) => ids[c]);
    return present.length ? [{ id: g.id, countries: present, exercises: ids }] : [];
  });
  return {
    candidates: [...byCountry.values()], concepts, groups,
    identifyPool: exercises.filter((e) => e.kind === 'identify-country').map((e) => e.country),
  };
}

/** the world map's geometry, once its blob is read, and its credits */
function useGeometry(): { geo: Geometry | null; sources: unknown } {
  const map = useQuery({ gestalt: 'map@1', where: { name: 'world' }, limit: 1 }).items[0];
  const url = useBlobUrl(str(map?.value.geometry) || undefined);
  const [geo, setGeo] = useState<Geometry | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    void fetch(url).then((r) => r.json()).then((g: Geometry) => { if (live) setGeo(g); });
    return () => { live = false; };
  }, [url]);
  return { geo, sources: map?.value.sources };
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-base-content/70">{children}</div>;
}

export default function WorldMap() {
  const { geo, sources: credit } = useGeometry();
  const exercises = useAll(useQuery({ gestalt: 'map-exercise@1', tags: { all: ['world-map'] }, limit: 500 }));
  const models = useAll(useQuery({ gestalt: 'item-model@1', tags: { all: ['world-map'] }, fields: ['name'], limit: 500 }));
  const groupItems = useAll(useQuery({ gestalt: 'country-group@1', limit: 500 }));
  const deck = useMemo(() => buildDeck(exercises.items, models.items, groupItems.items), [exercises.items, models.items, groupItems.items]);
  // the cards of this deck's countries and exercises: as many as the deck has, however much is practised
  const conceptIds = useMemo(() => [...new Set(deck.concepts.values())].sort(), [deck]);
  const countryCards = useAll(useQuery(conceptIds.length ? { gestalt: 'fsrs-data@1', links: { all: [{ field: 'target', to: { ids: conceptIds } }] }, limit: 500 } : null));
  const exerciseCards = useAll(useQuery({ gestalt: 'fsrs-data@1', links: { all: [{ field: 'target', to: { gestalt: 'map-exercise@1', tags: { all: ['world-map'] } } }] }, limit: 500 }));
  const stored = useMemo(() => fsrsStates([...countryCards.items, ...exerciseCards.items]), [countryCards.items, exerciseCards.items]);
  const { states, put } = useLocalReviews(stored);
  const statesRef = useRef(states);
  useLayoutEffect(() => { statesRef.current = states; }, [states]);

  const write = useWrite();
  const log = usePracticeSession(VIEW);
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);
  useEffect(() => { void getScheduler().then(setScheduler); }, []);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ next: Next | null; n: number } | null>(null);
  const lastCountry = useRef<string | null>(null);

  const loaded = !!geo && !!scheduler && ready(exercises, models, groupItems, exerciseCards) && (!conceptIds.length || ready(countryCards));
  const loadNext = useCallback((from: FsrsStates) => {
    const picked = loadNextExercise(deck, from, lastCountry.current, new Date());
    if (picked) lastCountry.current = picked.country;
    setCurrent((c) => ({ next: picked?.next ?? null, n: (c?.n ?? 0) + 1 }));
  }, [deck]);
  useEffect(() => {
    if (loaded && !current) loadNext(statesRef.current);
  }, [loaded, current, loadNext]);

  /** the old app's `submitAnswer`: both cards and the event; returns the states with them */
  const record = useCallback((a: Answer): FsrsStates => {
    const now = new Date();
    const fail = (e: unknown) => setError(message(e));
    const grade = a.gaveUp || a.numberOfClicksNeeded !== 1 ? Rating.Again : Rating.Good;
    let s = statesRef.current;
    const concept = deck.concepts.get(a.country);
    const facets = [...(concept ? [countryFacet(concept)] : []), exerciseFacet(a.exercise, a.type === 'find-in-neighborhood' ? a.panIndex : undefined)];
    facets.forEach((f, i) => {
      const prev = s.get(f);
      const next = { ...review(scheduler!, prev, grade, now), id: prev?.id };
      s = s.with(f, next);
      put(f, next);
      // the session counts one trial per answer: with the exercise's card
      saveReview(write, f, prev, next, i === facets.length - 1 ? log : undefined).catch(fail);
    });
    statesRef.current = s;
    const labels: JsonMap = { ...(a.panIndex === undefined ? {} : { panIndex: a.panIndex }), ...(a.distractor ? { distractor: a.distractor } : {}) };
    const rating = a.gaveUp ? -2 : a.numberOfClicksNeeded === 1 ? 1 : -1;
    logPractice(write, a.exercise, VIEW, rating, now, { ms: Math.round(a.msToFirstClick), ...(Object.keys(labels).length ? { instance: { labels } } : {}) }).catch(fail);
    return s;
  }, [deck, scheduler, put, write, log]);
  const submitted = useCallback((a: Answer) => loadNext(record(a)), [record, loadNext]);
  const shown = useCallback(() => log.shown(), [log]);

  let body: ReactNode;
  if (!loaded || !geo || !current) body = <Centered>Loading…</Centered>;
  else if (!current.next) body = <Centered><p>No countries enabled yet.</p></Centered>;
  else {
    const next = current.next;
    const key = current.n;
    if (next.type === 'find-in-neighborhood' || next.type === 'find-on-world-map') body = <FindExercise key={key} geo={geo} next={next} onShown={shown} onSubmitted={submitted} />;
    else if (next.type === 'group-sequence') body = <GroupSequenceExercise key={key} geo={geo} next={next} onShown={shown} onStep={record} onSubmitted={submitted} />;
    else body = <ChoiceExercise key={key} geo={geo} next={next} onShown={shown} onSubmitted={submitted} />;
  }

  return (
    <section className="relative h-full w-full overflow-hidden">
      {body}
      {error && (
        <div role="alert" className="alert alert-error absolute inset-x-3 top-3 text-sm">
          <span>Couldn't save your last answer: {error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-0 left-0 px-2 leading-tight"><Credits sources={credit} className="pointer-events-auto" /></div>
    </section>
  );
}


/**
 * What a viz's state is: named params, each with a kind, a default and how it's shown. The runtime makes the controls
 * from these (native inputs), and they're all a viz may keep: whatever someone sees is a function of them.
 */

export type Vec = readonly [number, number];

type Shown = {
  /** the control's label; the param's name by default */
  label?: string;
  /** false: no control (a param driven only by the clock or by dragging) */
  control?: boolean;
};

export type RangeParam = Shown & { kind: 'range'; min: number; max: number; step?: number; value: number };
export type ToggleParam = Shown & { kind: 'toggle'; value: boolean };
export type ChoiceParam<T extends string = string> = Shown & { kind: 'choice'; options: readonly T[]; value: T };
/** a point, dragged by `handles` in a panel */
export type PointParam = Shown & { kind: 'point'; value: Vec };
export type PointsParam = Shown & { kind: 'points'; value: readonly Vec[] };

export type ParamSpec = RangeParam | ToggleParam | ChoiceParam | PointParam | PointsParam;
export type ParamSpecs = Record<string, ParamSpec>;

export type ValueOf<P> = P extends RangeParam ? number
  : P extends ToggleParam ? boolean
  : P extends ChoiceParam<infer T> ? T
  : P extends PointParam ? Vec
  : P extends PointsParam ? readonly Vec[]
  : never;

export type Values<S extends ParamSpecs> = { readonly [K in keyof S]: ValueOf<S[K]> };

export const range = (min: number, max: number, value: number, o: Shown & { step?: number } = {}): RangeParam =>
  ({ kind: 'range', min, max, value, ...o });
export const toggle = (value: boolean, o: Shown = {}): ToggleParam => ({ kind: 'toggle', value, ...o });
export const choice = <T extends string>(options: readonly T[], value: T, o: Shown = {}): ChoiceParam<T> =>
  ({ kind: 'choice', options, value, ...o });
export const point = (value: Vec, o: Shown = {}): PointParam => ({ kind: 'point', value, control: false, ...o });
export const points = (value: readonly Vec[], o: Shown = {}): PointsParam => ({ kind: 'points', value, control: false, ...o });

export function defaults<S extends ParamSpecs>(specs: S): Values<S> {
  return Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, s.value])) as Values<S>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `v` made valid for `spec`, or undefined when it can't be */
export function coerce(spec: ParamSpec, v: unknown): unknown {
  switch (spec.kind) {
    case 'range': {
      const n = typeof v === 'number' ? v : Number.NaN;
      if (!Number.isFinite(n)) return undefined;
      const c = clamp(n, spec.min, spec.max);
      return spec.step ? clamp(spec.min + Math.round((c - spec.min) / spec.step) * spec.step, spec.min, spec.max) : c;
    }
    case 'toggle': return typeof v === 'boolean' ? v : undefined;
    case 'choice': return typeof v === 'string' && spec.options.includes(v) ? v : undefined;
    case 'point': return isVec(v) ? v : undefined;
    case 'points': return Array.isArray(v) && v.every(isVec) ? v : undefined;
  }
}

const isVec = (v: unknown): v is Vec =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

const num = (n: number) => String(Number(n.toPrecision(6)));

/** One param as a string, for a link: `0.5`, `1`/`0`, `fast`, `0.3,1`, `0,0;0.3,1`. */
export function encode(spec: ParamSpec, v: unknown): string {
  switch (spec.kind) {
    case 'range': return num(v as number);
    case 'toggle': return v ? '1' : '0';
    case 'choice': return String(v);
    case 'point': return (v as Vec).map(num).join(',');
    case 'points': return (v as readonly Vec[]).map((p) => p.map(num).join(',')).join(';');
  }
}

/** The inverse of `encode`; undefined for anything that isn't a valid value of `spec`. */
export function decode(spec: ParamSpec, s: string): unknown {
  const vec = (t: string) => t.split(',').map(Number);
  switch (spec.kind) {
    case 'range': return s.trim() === '' ? undefined : coerce(spec, Number(s));
    case 'toggle': return s === '1' ? true : s === '0' ? false : undefined;
    case 'choice': return coerce(spec, s);
    case 'point': return coerce(spec, vec(s));
    case 'points': return s === '' ? undefined : coerce(spec, s.split(';').map(vec));
  }
}

/** The params that differ from their defaults, encoded: what a link to this state needs. */
export function encodeAll(specs: ParamSpecs, values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, spec] of Object.entries(specs)) {
    const s = encode(spec, values[k]);
    if (s !== encode(spec, spec.value)) out[k] = s;
  }
  return out;
}

/** Defaults, with whatever of `given` is valid on top. */
export function decodeAll<S extends ParamSpecs>(specs: S, given: Record<string, string>): Values<S> {
  const out: Record<string, unknown> = { ...defaults(specs) };
  for (const [k, s] of Object.entries(given)) {
    const spec = specs[k];
    const v = spec && decode(spec, s);
    if (v !== undefined) out[k] = v;
  }
  return out as Values<S>;
}
